const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const remoteMain = require("@electron/remote/main");

remoteMain.initialize();

let appDir;
let dbPath;
let backupDir;
let secondaryBackupDir;

function initializePaths() {
  if (app.isPackaged) {
    appDir = app.getPath("userData");

    if (!fs.existsSync(appDir)) {
      fs.mkdirSync(appDir, { recursive: true });
    }
  } else {
    appDir = __dirname;
  }

  dbPath = path.join(appDir, "neptune-pos.db");
  backupDir = path.join(appDir, "database_backups");

  // Secondary backup location on D: drive (or another partition)
  // Try D: first, then E:, then F: if they exist
  const drivesToTry = ['D:', 'E:', 'F:'];
  for (const drive of drivesToTry) {
    try {
      const testPath = path.join(drive, 'Neptune_POS_Backups');
      // Try to create the directory
      if (!fs.existsSync(testPath)) {
        fs.mkdirSync(testPath, { recursive: true });
      }
      // If successful, use this as secondary backup
      secondaryBackupDir = testPath;
      break;
    } catch (e) {
      // Drive doesn't exist or no permission, try next
      continue;
    }
  }

  console.log("Main - App Directory:", appDir);
  console.log("Main - Database Path:", dbPath);
  console.log("Main - Backup Directory:", backupDir);
  console.log("Main - Secondary Backup Directory:", secondaryBackupDir || "Not available");

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
}
try {
  require("electron-reloader")(module, {
    watchRenderer: true,
    ignore: ["neptune-pos.db", "neptune-pos.db-*", "*.db", "*.db-*"],
  });
} catch {}

let mainWindow;
let db;

function initializeDatabase() {
  if (!fs.existsSync(dbPath)) {
    const defaultDbPath = path.join(__dirname, "neptune-pos.db");
    if (fs.existsSync(defaultDbPath)) {
      fs.copyFileSync(defaultDbPath, dbPath);
    }
  }

  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_code TEXT UNIQUE NOT NULL,
      product_name TEXT NOT NULL,
      cost REAL NOT NULL,
      qty INTEGER DEFAULT 0,
      total_cost REAL GENERATED ALWAYS AS (cost * qty) STORED,
      sale_price REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    const tableInfo = db.pragma("table_info(products)");
    const hasBarcodeColumn = tableInfo.some((col) => col.name === "barcode");
    const hasUpdatedAtColumn = tableInfo.some(
      (col) => col.name === "updated_at"
    );

    if (hasBarcodeColumn || !hasUpdatedAtColumn) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS products_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_code TEXT UNIQUE NOT NULL,
          product_name TEXT NOT NULL,
          cost REAL NOT NULL,
          qty INTEGER DEFAULT 0,
          total_cost REAL GENERATED ALWAYS AS (cost * qty) STORED,
          sale_price REAL NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO products_new (id, product_code, product_name, cost, qty, sale_price, created_at, updated_at)
        SELECT id, product_code, product_name, cost, qty, sale_price,
               COALESCE(created_at, CURRENT_TIMESTAMP),
               COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
        FROM products;

        DROP TABLE products;
        ALTER TABLE products_new RENAME TO products;
      `);
      console.log("Products table schema updated successfully");
    }
  } catch (error) {
    console.log("Table migration check:", error.message);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      total_cost REAL NOT NULL,
      total_sale_price REAL NOT NULL,
      profit REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      cost_per_unit REAL NOT NULL,
      sale_price_per_unit REAL NOT NULL,
      total_cost REAL NOT NULL,
      total_sale_price REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary_date DATE UNIQUE NOT NULL,
      total_cost REAL NOT NULL,
      total_sale_price REAL NOT NULL,
      total_profit REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mobile TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN customer_name TEXT`);
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN customer_mobile TEXT`);
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE customers ADD COLUMN mobile TEXT`);
  } catch (e) {}

  try {
    db.exec(
      `ALTER TABLE customers ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`
    );
  } catch (e) {}

  // Returns Management Tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      return_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      total_return_amount REAL NOT NULL,
      notes TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL,
      order_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      return_status TEXT NOT NULL CHECK(return_status IN ('accepted', 'damaged', 'rejected')),
      sale_price_per_unit REAL NOT NULL,
      total_return_amount REAL NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (return_id) REFERENCES returns(id),
      FOREIGN KEY (order_item_id) REFERENCES order_items(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT UNIQUE NOT NULL,
      setting_value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Initialize default GRN password
  try {
    const checkGrnPassword = db.prepare(
      "SELECT * FROM settings WHERE setting_key = 'grn_password'"
    );
    const existingPassword = checkGrnPassword.get();

    if (!existingPassword) {
      const insertPassword = db.prepare(
        "INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)"
      );
      insertPassword.run("grn_password", "200122300341");
      console.log("Default GRN password initialized");
    }
  } catch (e) {
    console.log("GRN password initialization check:", e.message);
  }

  console.log("Database initialized successfully");
}

function createWindow() {
  // Get the primary display dimensions
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    show: false, // Start hidden, show when ready
    frame: false, // Remove window controls (minimize, maximize, close buttons)
    fullscreen: true, // Start in fullscreen mode
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
  });

  remoteMain.enable(mainWindow.webContents);

  mainWindow.setMenu(null);

  mainWindow.loadFile("index.html");

  // Show window when ready to prevent white flash and ensure it's visible
  mainWindow.once("ready-to-show", () => {
    mainWindow.setFullScreen(true); // Ensure fullscreen is active
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Enable DevTools with F12
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12") {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

function createDailyBackup() {
  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];
    const backupFileName = `neptune-pos-backup-${dateStr}.db`;
    const backupPath = path.join(backupDir, backupFileName);

    if (fs.existsSync(dbPath)) {
      // Create backup in primary location (C: partition)
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(dbPath, backupPath);
        console.log("Primary backup created:", backupPath);

        // Clean up old backups in primary location (keep last 30)
        const files = fs
          .readdirSync(backupDir)
          .filter(
            (file) =>
              file.startsWith("neptune-pos-backup-") && file.endsWith(".db")
          )
          .map((file) => ({
            name: file,
            path: path.join(backupDir, file),
            time: fs.statSync(path.join(backupDir, file)).mtime.getTime(),
          }))
          .sort((a, b) => b.time - a.time);

        if (files.length > 30) {
          files.slice(30).forEach((file) => {
            fs.unlinkSync(file.path);
            console.log("Deleted old primary backup:", file.name);
          });
        }
      } else {
        console.log("Primary backup already exists for today:", backupPath);
      }

      // Create backup in secondary location (different partition)
      if (secondaryBackupDir) {
        const secondaryBackupPath = path.join(secondaryBackupDir, backupFileName);

        if (!fs.existsSync(secondaryBackupPath)) {
          fs.copyFileSync(dbPath, secondaryBackupPath);
          console.log("Secondary backup created:", secondaryBackupPath);

          // Clean up old backups in secondary location (keep last 30)
          const secondaryFiles = fs
            .readdirSync(secondaryBackupDir)
            .filter(
              (file) =>
                file.startsWith("neptune-pos-backup-") && file.endsWith(".db")
            )
            .map((file) => ({
              name: file,
              path: path.join(secondaryBackupDir, file),
              time: fs.statSync(path.join(secondaryBackupDir, file)).mtime.getTime(),
            }))
            .sort((a, b) => b.time - a.time);

          if (secondaryFiles.length > 30) {
            secondaryFiles.slice(30).forEach((file) => {
              fs.unlinkSync(file.path);
              console.log("Deleted old secondary backup:", file.name);
            });
          }
        } else {
          console.log("Secondary backup already exists for today:", secondaryBackupPath);
        }
      }
    }
  } catch (error) {
    console.error("Error creating backup:", error);
  }
}
ipcMain.on("close-app", () => {
  createDailyBackup();
  if (db) {
    db.close();
  }
  app.quit();
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    initializePaths();
    initializeDatabase();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (db) {
    db.close();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

module.exports = { db };
