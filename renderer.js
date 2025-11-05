const Database = require("better-sqlite3");
const { ipcRenderer } = require("electron");
const path = require("path");
const fs = require("fs");
const { app } = require("@electron/remote");

const appDir = app.getPath("userData");
const dbPath = path.join(appDir, "neptune-pos.db");

console.log("Renderer - Database Path:", dbPath);

const db = new Database(dbPath);

// Initialize all tables if they don't exist
function initializeDatabaseTables() {
  try {
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

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER,
        customer_name TEXT,
        customer_mobile TEXT,
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
    console.log("✓ Database tables initialized");
  } catch (error) {
    console.error("Error initializing database tables:", error);
  }
}

// Initialize tables immediately
initializeDatabaseTables();

let currentUserRole = null; // 'cashier', 'grn', 'admin'
let isLoggedIn = false;

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "20011002";
const GRN_USERNAME = "savindu";
const CASHIER_USERNAME = "cashier";

// Initialize settings table if it doesn't exist
function initializeSettingsTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        setting_key TEXT UNIQUE NOT NULL,
        setting_value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Check if GRN password exists, if not create it
    const checkStmt = db.prepare("SELECT * FROM settings WHERE setting_key = 'grn_password'");
    const existing = checkStmt.get();

    if (!existing) {
      const insertStmt = db.prepare("INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)");
      insertStmt.run('grn_password', '200122300341');
      console.log("GRN password initialized");
    }
  } catch (error) {
    console.error("Error initializing settings table:", error);
  }
}

function getGRNPassword() {
  try {
    // Make sure settings table exists first
    initializeSettingsTable();

    const stmt = db.prepare("SELECT setting_value FROM settings WHERE setting_key = 'grn_password'");
    const result = stmt.get();
    return result ? result.setting_value : "200122300341";
  } catch (error) {
    console.error("Error getting GRN password:", error);
    return "200122300341";
  }
}

let cart = [];
let selectedProduct = null;
let lastSpaceTime = 0;
let currentSearchResultIndex = -1;
let lastPaidAmountSpaceTime = 0;
let savedOrderId = null;
let lastProductCodeSpaceTime = 0;
function showErrorModal(message, onClose) {
  const modal = document.getElementById("error-modal");
  const errorMessage = document.getElementById("error-message");
  const closeBtn = document.getElementById("error-close-btn");

  errorMessage.textContent = message;
  modal.style.display = "flex";

  const handleClose = () => {
    modal.style.display = "none";
    closeBtn.removeEventListener("click", handleClose);
    document.removeEventListener("keydown", handleKeyPress);
    if (onClose) onClose();
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleClose();
    }
  };

  closeBtn.addEventListener("click", (e) => {
    e.target.blur();
    handleClose();
  });
  document.addEventListener("keydown", handleKeyPress);

  setTimeout(() => closeBtn.focus(), 100);
}

function showConfirmModal(title, message, onYes, onNo) {
  const modal = document.getElementById("confirm-modal");
  const confirmTitle = document.getElementById("confirm-title");
  const confirmMessage = document.getElementById("confirm-message");
  const yesBtn = document.getElementById("confirm-yes-btn");
  const noBtn = document.getElementById("confirm-no-btn");

  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  modal.style.display = "flex";

  const handleYes = () => {
    modal.style.display = "none";
    yesBtn.removeEventListener("click", handleYes);
    noBtn.removeEventListener("click", handleNo);
    document.removeEventListener("keydown", handleKeyPress);
    if (onYes) onYes();
  };

  const handleNo = () => {
    modal.style.display = "none";
    yesBtn.removeEventListener("click", handleYes);
    noBtn.removeEventListener("click", handleNo);
    document.removeEventListener("keydown", handleKeyPress);
    if (onNo) onNo();
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleYes();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleNo();
    }
  };

  yesBtn.addEventListener("click", (e) => {
    e.target.blur();
    handleYes();
  });
  noBtn.addEventListener("click", (e) => {
    e.target.blur();
    handleNo();
  });
  document.addEventListener("keydown", handleKeyPress);

  setTimeout(() => yesBtn.focus(), 100);
}

function showSuccessModal(message, onClose) {
  const modal = document.getElementById("success-modal");
  const successMessage = document.getElementById("success-message");
  const closeBtn = document.getElementById("success-close-btn");

  successMessage.textContent = message;
  modal.style.display = "flex";

  const handleClose = () => {
    modal.style.display = "none";
    closeBtn.removeEventListener("click", handleClose);
    document.removeEventListener("keydown", handleKeyPress);
    if (onClose) onClose();
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleClose();
    }
  };

  closeBtn.addEventListener("click", (e) => {
    e.target.blur();
    handleClose();
  });
  document.addEventListener("keydown", handleKeyPress);

  setTimeout(() => closeBtn.focus(), 100);
}

document
  .getElementById("nav-pos")
  .addEventListener("click", () => switchSection("pos"));
document
  .getElementById("nav-inventory")
  .addEventListener("click", () => switchSection("inventory"));
document
  .getElementById("nav-analytics")
  .addEventListener("click", () => switchSection("analytics"));
document
  .getElementById("nav-order-history")
  .addEventListener("click", () => switchSection("order-history"));
document
  .getElementById("nav-customers")
  .addEventListener("click", () => switchSection("customers"));
document
  .getElementById("nav-reports")
  .addEventListener("click", () => switchSection("reports"));
document
  .getElementById("nav-settings")
  .addEventListener("click", () => switchSection("settings"));

function switchSection(section) {
  // Define section access based on roles
  const adminOnlySections = ["analytics", "order-history", "customers", "reports", "settings"];
  const grnSections = ["inventory"];
  const allSections = ["pos", ...grnSections, ...adminOnlySections];

  // Check access permissions
  if (!isLoggedIn && section !== "pos") {
    showErrorModal("Please login to access this section!", () => {
      showLoginModal();
    });
    return;
  }

  if (currentUserRole === "cashier" && section !== "pos") {
    showErrorModal("Access denied! Cashier can only access Sales section.", () => {
      switchSection("pos");
    });
    return;
  }

  if (currentUserRole === "grn" && adminOnlySections.includes(section)) {
    showErrorModal("Access denied! GRN staff can only access Sales and GRN sections.", () => {
      switchSection("pos");
    });
    return;
  }

  if (currentUserRole !== "admin" && section === "settings") {
    showErrorModal("Access denied! Only admin can access Settings.", () => {
      showLoginModal();
    });
    return;
  }

  document
    .querySelectorAll(".section")
    .forEach((s) => s.classList.remove("active"));
  document
    .querySelectorAll(".nav-btn")
    .forEach((btn) => btn.classList.remove("active"));

  document.getElementById(`${section}-section`).classList.add("active");
  document.getElementById(`nav-${section}`).classList.add("active");

  if (section === "inventory") {
    loadGRNTable();
  } else if (section === "pos") {
    focusProductCodeInput();
    updateResetButtonVisibility();
  } else if (section === "analytics") {
    loadAnalytics();
  } else if (section === "order-history") {
    loadOrderHistory();
  } else if (section === "customers") {
    loadCustomers();
  } else if (section === "reports") {
    loadDailyReport();
  } else if (section === "settings") {
    // Settings section - no need to load data
  }

  updateResetButtonVisibility();
}

function focusProductCodeInput() {
  setTimeout(() => {
    const input = document.getElementById("product-code-input");
    if (input) {
      input.focus();
    }
  }, 100);
}

// Customer Autocomplete Functionality
function initializeCustomerAutocomplete() {
  const customerNameInput = document.getElementById("customer-name-input");
  const customerMobileInput = document.getElementById("customer-mobile-input");
  const dropdown = document.getElementById("customer-dropdown");
  let selectedIndex = -1;

  // Search and show dropdown on input
  customerNameInput.addEventListener("input", (e) => {
    const searchValue = e.target.value.trim();

    if (searchValue.length === 0) {
      dropdown.style.display = "none";
      return;
    }

    // Search customers by name or mobile
    const searchStmt = db.prepare(`
      SELECT DISTINCT name, mobile
      FROM customers
      WHERE name LIKE ? OR mobile LIKE ?
      ORDER BY name
      LIMIT 10
    `);
    const searchPattern = `%${searchValue}%`;
    const customers = searchStmt.all(searchPattern, searchPattern);

    if (customers.length === 0) {
      dropdown.style.display = "none";
      return;
    }

    // Build dropdown HTML
    dropdown.innerHTML = customers
      .map((customer, index) => `
        <div class="customer-autocomplete-item" data-index="${index}" data-name="${customer.name}" data-mobile="${customer.mobile || ''}">
          <div class="customer-name">${customer.name}</div>
          <div class="customer-mobile">${customer.mobile || 'No mobile'}</div>
        </div>
      `)
      .join("");

    dropdown.style.display = "block";
    selectedIndex = -1;

    // Add click handlers to items
    dropdown.querySelectorAll(".customer-autocomplete-item").forEach((item) => {
      item.addEventListener("click", () => {
        selectCustomer(item.dataset.name, item.dataset.mobile);
      });
    });
  });

  // Keyboard navigation
  customerNameInput.addEventListener("keydown", (e) => {
    const items = dropdown.querySelectorAll(".customer-autocomplete-item");

    if (dropdown.style.display === "none" || items.length === 0) {
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateSelection(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, -1);
      updateSelection(items);
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      const selectedItem = items[selectedIndex];
      selectCustomer(selectedItem.dataset.name, selectedItem.dataset.mobile);
    } else if (e.key === "Escape") {
      dropdown.style.display = "none";
      selectedIndex = -1;
    }
  });

  function updateSelection(items) {
    items.forEach((item, index) => {
      if (index === selectedIndex) {
        item.style.backgroundColor = "var(--bg-light)";
      } else {
        item.style.backgroundColor = "";
      }
    });
  }

  function selectCustomer(name, mobile) {
    customerNameInput.value = name;
    customerMobileInput.value = mobile || "";
    dropdown.style.display = "none";
    selectedIndex = -1;
    customerMobileInput.focus();
  }

  // Hide dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (!customerNameInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = "none";
      selectedIndex = -1;
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  // Initialize settings table on app start
  initializeSettingsTable();

  updateUIBasedOnAuth();
  focusProductCodeInput();
  updateCart();

  // Initialize customer autocomplete
  initializeCustomerAutocomplete();
});

let lastProductCodeEnterTime = 0;

document
  .getElementById("product-code-input")
  .addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateSearchResults("down");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateSearchResults("up");
    } else if (e.key === "Enter") {
      e.preventDefault();

      const currentTime = Date.now();

      // Check if this is a double Enter (within 500ms)
      if (currentTime - lastProductCodeEnterTime < 500) {
        // Double Enter - Jump to paid amount
        lastProductCodeEnterTime = 0; // Reset to prevent triple enter
        document.getElementById("paid-amount-input").focus();
      } else {
        // First Enter - Select product normally
        lastProductCodeEnterTime = currentTime;
        selectCurrentSearchResult();
      }
    }
  });

document.getElementById("product-code-input").addEventListener("keyup", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
    return;
  }

  const query = e.target.value.trim();

  if (query.length === 0) {
    document.getElementById("search-results-body").innerHTML = "";
    currentSearchResultIndex = -1;
    hideSelectedProductDetails();
    return;
  }

  const stmt = db.prepare(`
    SELECT * FROM products
    WHERE LOWER(product_code) LIKE ? OR LOWER(product_name) LIKE ?
    LIMIT 10
  `);

  const products = stmt.all(
    `%${query.toLowerCase()}%`,
    `%${query.toLowerCase()}%`
  );

  currentSearchResultIndex = -1; // Reset index on new search
  displaySearchResults(products);
});

function navigateSearchResults(direction) {
  const rows = document.querySelectorAll(
    "#search-results-body tr[data-product-id]"
  );

  if (rows.length === 0) return;

  rows.forEach((row) => row.classList.remove("selected"));

  if (direction === "down") {
    currentSearchResultIndex = (currentSearchResultIndex + 1) % rows.length;
  } else if (direction === "up") {
    currentSearchResultIndex =
      currentSearchResultIndex <= 0
        ? rows.length - 1
        : currentSearchResultIndex - 1;
  }

  rows[currentSearchResultIndex].classList.add("selected");

  rows[currentSearchResultIndex].scrollIntoView({
    block: "nearest",
    behavior: "smooth",
  });
}

function selectCurrentSearchResult() {
  const rows = document.querySelectorAll(
    "#search-results-body tr[data-product-id]"
  );

  // If no row is selected by arrow keys, select the first one
  if (currentSearchResultIndex < 0 && rows.length > 0) {
    currentSearchResultIndex = 0;
  }

  if (currentSearchResultIndex >= 0 && currentSearchResultIndex < rows.length) {
    const selectedRow = rows[currentSearchResultIndex];
    const productId = selectedRow.getAttribute("data-product-id");

    selectProductAndHideSearch(parseInt(productId));
  }
}

function displaySearchResults(products) {
  const tbody = document.getElementById("search-results-body");

  if (products.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" style="text-align: center; color: #999;">No products found</td></tr>';
    return;
  }

  // Auto-select if only one product found
  if (products.length === 1) {
    selectProductAndHideSearch(products[0].id);
    return;
  }

  tbody.innerHTML = products
    .map(
      (product) => `
    <tr onclick="selectProduct(${product.id})" data-product-id="${product.id}">
      <td>${product.product_code}</td>
      <td>${product.product_name}</td>
      <td>Rs. ${product.cost.toFixed(2)}</td>
      <td>Rs. ${product.sale_price.toFixed(2)}</td>
      <td>${product.qty}</td>
    </tr>
  `
    )
    .join("");
}

function selectProduct(productId) {
  document
    .querySelectorAll("#search-results-body tr")
    .forEach((tr) => tr.classList.remove("selected"));

  const selectedRow = document.querySelector(
    `#search-results-body tr[data-product-id="${productId}"]`
  );
  if (selectedRow) {
    selectedRow.classList.add("selected");
  }

  const stmt = db.prepare("SELECT * FROM products WHERE id = ?");
  const product = stmt.get(productId);

  if (!product) return;

  if (product.qty <= 0) {
    showErrorModal("Product out of stock!", () => {
      focusProductCodeInput();
    });
    return;
  }

  selectedProduct = product;

  showQtyPriceSection(product);
}

function selectProductAndHideSearch(productId) {
  const stmt = db.prepare("SELECT * FROM products WHERE id = ?");
  const product = stmt.get(productId);

  if (!product) return;

  // Allow out-of-stock products to be selected (for returns)
  // Stock validation will happen when adding to cart based on quantity (positive/negative)

  selectedProduct = product;

  document.getElementById("search-results-container").style.display = "none";
  currentSearchResultIndex = -1;

  showSelectedProductDetails(product);
}

function showSelectedProductDetails(product) {
  const section = document.getElementById("selected-product-section");
  section.style.display = "block";

  document.getElementById("selected-product-code").textContent =
    product.product_code;
  document.getElementById("selected-product-name").textContent =
    product.product_name;
  document.getElementById(
    "selected-product-cost"
  ).textContent = `Rs. ${product.cost.toFixed(2)}`;
  document.getElementById("selected-product-available-qty").textContent =
    product.qty;

  document.getElementById(
    "default-sale-price"
  ).value = `Rs. ${product.sale_price.toFixed(2)}`;

  const qtyInput = document.getElementById("qty-input");
  qtyInput.value = "";
  qtyInput.focus();

  const salePriceInput = document.getElementById("sale-price-input");
  salePriceInput.value = "";
  salePriceInput.min = product.cost;
}

function hideSelectedProductDetails() {
  document.getElementById("selected-product-section").style.display = "none";
  document.getElementById("search-results-container").style.display = "flex";
}

function showQtyPriceSection(product) {
  selectProductAndHideSearch(product.id);
}

document.getElementById("qty-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();

    const qtyInput = document.getElementById("qty-input");
    const qtyValue = qtyInput.value.trim();
    const qty = parseInt(qtyValue);

    if (qtyValue === "" || isNaN(qty) || qty === 0) {
      showErrorModal("Please enter a valid quantity (not zero)!", () => {
        qtyInput.value = "";
        setTimeout(() => qtyInput.focus(), 10);
      });
      return;
    }

    // Positive quantity - normal sale
    if (qty > 0) {
      if (qty > selectedProduct.qty) {
        showErrorModal(
          `Only ${selectedProduct.qty} units available in stock!`,
          () => {
            qtyInput.value = "";
            setTimeout(() => qtyInput.focus(), 10);
          }
        );
        return;
      }
    }
    // Negative quantity - return (no stock check needed)

    document.getElementById("sale-price-input").focus();
  }
});

document.getElementById("sale-price-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();

    // If empty, use default price and add to cart
    const salePriceInput = document.getElementById("sale-price-input");
    if (salePriceInput.value.trim() === "") {
      salePriceInput.value = selectedProduct.sale_price;
    }

    addItemToCart();
  }
});

function addItemToCart() {
  if (!selectedProduct) {
    showErrorModal("Please select a product first!", () => {
      focusProductCodeInput();
    });
    return;
  }

  const salePriceInput = document.getElementById("sale-price-input");
  const qtyInput = document.getElementById("qty-input");

  const qtyValue = qtyInput.value.trim();
  const qty = parseInt(qtyValue);

  const salePriceValue = salePriceInput.value.trim();
  let salePrice = parseFloat(salePriceValue);

  if (salePriceValue === "" || isNaN(salePrice) || salePrice <= 0) {
    salePrice = selectedProduct.sale_price;
  }

  if (qtyValue === "" || isNaN(qty) || qty === 0) {
    showErrorModal("Please enter a valid quantity (not zero)!", () => {
      qtyInput.value = "";
      setTimeout(() => qtyInput.focus(), 10);
    });
    return;
  }

  // For positive quantities (sales), check stock
  if (qty > 0) {
    // Calculate total quantity already in cart for this product (only positive quantities)
    const qtyInCart = cart
      .filter(item => item.productId === selectedProduct.id && item.qty > 0)
      .reduce((sum, item) => sum + item.qty, 0);

    // Calculate available stock after cart items
    const availableStock = selectedProduct.qty - qtyInCart;

    if (qty > availableStock) {
      showErrorModal(
        `Only ${availableStock} units available in stock! (Total stock: ${selectedProduct.qty}, Already in cart: ${qtyInCart})`,
        () => {
          qtyInput.value = "";
          setTimeout(() => qtyInput.focus(), 10);
        }
      );
      return;
    }

    if (salePrice < selectedProduct.cost) {
      showErrorModal(
        `Sale price cannot be less than cost price (Rs. ${selectedProduct.cost.toFixed(
          2
        )})!`,
        () => {
          salePriceInput.value = "";
          setTimeout(() => salePriceInput.focus(), 10);
        }
      );
      return;
    }
  }

  // For negative quantities (returns), check against TODAY's sales only
  if (qty < 0) {
    const today = new Date().toISOString().split('T')[0]; // Get today's date in YYYY-MM-DD format

    // Get all sold records for this product TODAY with their prices
    const soldRecordsStmt = db.prepare(`
      SELECT quantity, sale_price_per_unit
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE oi.product_id = ? AND oi.quantity > 0 AND DATE(o.created_at) = ?
    `);
    const soldRecords = soldRecordsStmt.all(selectedProduct.id, today);

    // Check if product was never sold TODAY
    if (soldRecords.length === 0) {
      showErrorModal(
        `Cannot return this product! It has not been sold today.`,
        () => {
          qtyInput.value = "";
          setTimeout(() => qtyInput.focus(), 10);
        }
      );
      return;
    }

    // Get unique sold prices from today
    const soldPrices = [...new Set(soldRecords.map(r => r.sale_price_per_unit))];

    // Find the highest price this product was sold at today
    const maxSoldPrice = Math.max(...soldPrices);

    // Validate return price - must be <= highest sold price today
    if (salePrice > maxSoldPrice) {
      showErrorModal(
        `Invalid return price! Today this product was sold for max Rs. ${maxSoldPrice.toFixed(2)}. Cannot return at Rs. ${salePrice.toFixed(2)} (higher price).`,
        () => {
          salePriceInput.value = "";
          setTimeout(() => salePriceInput.focus(), 10);
        }
      );
      return;
    }

    // Calculate total quantity sold today (all prices)
    const totalSoldToday = soldRecords.reduce((sum, record) => sum + record.quantity, 0);

    // Get total already returned TODAY (negative quantities - already in DB)
    const returnedTodayStmt = db.prepare(`
      SELECT COALESCE(SUM(ABS(quantity)), 0) as total_returned
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE oi.product_id = ? AND oi.quantity < 0 AND DATE(o.created_at) = ?
    `);
    const returnedToday = returnedTodayStmt.get(selectedProduct.id, today).total_returned || 0;

    // Get total being returned in current cart
    const cartReturns = cart
      .filter(item => item.productId === selectedProduct.id && item.qty < 0)
      .reduce((sum, item) => sum + Math.abs(item.qty), 0);

    // Calculate available to return (based on today's sales only)
    const availableToReturn = totalSoldToday - returnedToday - cartReturns;

    if (Math.abs(qty) > availableToReturn) {
      showErrorModal(
        `Cannot return ${Math.abs(qty)} units! Only ${availableToReturn} units available to return from today's sales (Sold Today: ${totalSoldToday}, Already Returned: ${returnedToday}, In Cart: ${cartReturns}).`,
        () => {
          qtyInput.value = "";
          setTimeout(() => qtyInput.focus(), 10);
        }
      );
      return;
    }
  }

  const existingItem = cart.find(
    (item) =>
      item.productId === selectedProduct.id && item.salePrice === salePrice
  );

  if (existingItem) {
    const newQty = existingItem.qty + qty;

    // Only check stock for positive total quantity
    if (newQty > 0) {
      // Calculate total quantity in cart for this product (excluding the item we're updating)
      const qtyInCartExcludingThis = cart
        .filter(item => item.productId === selectedProduct.id && item !== existingItem && item.qty > 0)
        .reduce((sum, item) => sum + item.qty, 0);

      const availableStock = selectedProduct.qty - qtyInCartExcludingThis;

      if (newQty > availableStock) {
        showErrorModal(
          `Only ${availableStock} units available in stock!`,
          () => {
            setTimeout(() => qtyInput.focus(), 10);
          }
        );
        return;
      }
    }

    existingItem.qty = newQty;

    // Remove item if qty becomes zero
    if (existingItem.qty === 0) {
      const index = cart.indexOf(existingItem);
      cart.splice(index, 1);
    }
  } else {
    cart.push({
      productId: selectedProduct.id,
      productCode: selectedProduct.product_code,
      productName: selectedProduct.product_name,
      cost: selectedProduct.cost,
      salePrice: salePrice,
      qty: qty,
      availableQty: selectedProduct.qty,
      isReturn: qty < 0,
    });
  }

  updateCart();

  document.getElementById("product-code-input").value = "";
  document.getElementById("search-results-body").innerHTML = "";
  hideSelectedProductDetails();
  focusProductCodeInput();
}

function updateCart() {
  const tbody = document.getElementById("cart-items");

  if (cart.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align: center; color: #999;">Cart is empty</td></tr>';
    updateSummary();
    updateReturnModeUI();
    return;
  }

  tbody.innerHTML = cart
    .map(
      (item, index) => {
        const rowStyle = item.qty < 0 ? 'style="background-color: #ffd966; border-left: 3px solid #ff9900;"' : '';
        const qtyLabel = item.qty < 0 ? `${item.qty} (RETURN)` : item.qty;

        return `
    <tr ${rowStyle}>
      <td>${item.productCode}</td>
      <td>${item.productName}</td>
      <td>
        <input type="number"
               value="${item.salePrice}"
               step="0.01"
               min="0"
               onchange="updateCartItemPrice(${index}, this.value)"
               style="width: 100px;">
      </td>
      <td>
        <input type="number"
               value="${item.qty}"
               onchange="updateCartItemQty(${index}, this.value)"
               style="width: 80px;">
      </td>
      <td>Rs. ${(item.salePrice * item.qty).toFixed(2)}</td>
      <td>
        <button class="btn-danger" onclick="removeFromCart(${index})">Remove</button>
      </td>
    </tr>
  `;
      }
    )
    .join("");

  updateSummary();
  updateReturnModeUI();
}

function hasReturns() {
  return cart.some((item) => item.qty < 0);
}

function hasSales() {
  return cart.some((item) => item.qty > 0);
}

function updateReturnModeUI() {
  const hasReturnItems = hasReturns();
  const hasSaleItems = hasSales();

  // If cart has both returns and sales, it's a mixed cart - allow everything
  // If cart has ONLY returns (no sales), it's pure return mode - disable payment fields
  const isPureReturnMode = hasReturnItems && !hasSaleItems;

  // Disable/enable customer fields only for pure returns
  document.getElementById("customer-name-input").disabled = isPureReturnMode;
  document.getElementById("customer-mobile-input").disabled = isPureReturnMode;

  // Disable/enable paid amount field only for pure returns
  document.getElementById("paid-amount-input").disabled = isPureReturnMode;

  // Never disable print button - always allow saving
  document.getElementById("print-bill-btn").disabled = false;

  // Clear values when switching to pure return mode
  if (isPureReturnMode) {
    document.getElementById("customer-name-input").value = "";
    document.getElementById("customer-mobile-input").value = "";
    document.getElementById("paid-amount-input").value = "";
    document.getElementById("balance-display").style.display = "none";
  } else if (hasReturnItems && hasSaleItems) {
    // Mixed mode - show balance display if paid amount is entered
    const paidAmount = parseFloat(document.getElementById("paid-amount-input").value) || 0;
    if (paidAmount > 0) {
      document.getElementById("balance-display").style.display = "block";
    }
  }

  // Update button text - always the same
  const printBtn = document.getElementById("print-bill-btn");
  printBtn.textContent = "Save & Print (Enter)";
  printBtn.classList.remove("btn-warning");
  printBtn.classList.add("btn-print");
}

function updateCartItemQty(index, newQty) {
  const qty = parseInt(newQty);
  const item = cart[index];

  if (!qty || qty === 0) {
    showErrorModal("Quantity cannot be zero!", () => {
      updateCart();
    });
    return;
  }

  // For positive quantities (sales), check stock
  if (qty > 0 && qty > item.availableQty) {
    showErrorModal(`Only ${item.availableQty} units available!`, () => {
      updateCart();
    });
    return;
  }

  // For negative quantities (returns), check if return qty doesn't exceed net sold qty
  if (qty < 0) {
    // Get total sold (positive quantities)
    const soldQtyStmt = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as total_sold
      FROM order_items
      WHERE product_id = ? AND quantity > 0
    `);
    const soldResult = soldQtyStmt.get(item.productId);
    const totalSold = soldResult.total_sold || 0;

    // Check if product was never sold
    if (totalSold === 0) {
      showErrorModal(
        `Cannot return this product! It has never been sold.`,
        () => {
          updateCart();
        }
      );
      return;
    }

    // Get total already returned (negative quantities - already in DB)
    const returnedQtyStmt = db.prepare(`
      SELECT COALESCE(SUM(ABS(quantity)), 0) as total_returned
      FROM order_items
      WHERE product_id = ? AND quantity < 0
    `);
    const returnedResult = returnedQtyStmt.get(item.productId);
    const totalReturned = returnedResult.total_returned || 0;

    // Get total being returned in current cart (excluding this item since we're updating it)
    const cartReturns = cart
      .filter((cartItem, cartIndex) => cartIndex !== index && cartItem.productId === item.productId && cartItem.qty < 0)
      .reduce((sum, cartItem) => sum + Math.abs(cartItem.qty), 0);

    // Calculate available to return
    const availableToReturn = totalSold - totalReturned - cartReturns;

    if (Math.abs(qty) > availableToReturn) {
      showErrorModal(
        `Cannot return ${Math.abs(qty)} units! Only ${availableToReturn} units available to return (Sold: ${totalSold}, Already Returned: ${totalReturned}, In Cart: ${cartReturns}).`,
        () => {
          updateCart();
        }
      );
      return;
    }
  }

  item.qty = qty;
  item.isReturn = qty < 0;
  updateCart();
  checkPaidAmountValidity(); // Check if paid amount is still sufficient
}

function updateCartItemPrice(index, newPrice) {
  const price = parseFloat(newPrice);
  const item = cart[index];

  if (!price || price <= 0) {
    showErrorModal("Price must be greater than 0!", () => {
      updateCart();
    });
    return;
  }

  // Only check cost price for sales (positive qty), not for returns (negative qty)
  if (item.qty > 0 && price < item.cost) {
    showErrorModal(
      `Price cannot be less than cost (Rs. ${item.cost.toFixed(2)})!`,
      () => {
        updateCart();
      }
    );
    return;
  }

  item.salePrice = price;
  updateCart();
  checkPaidAmountValidity(); // Check if paid amount is still sufficient
}

function checkPaidAmountValidity() {
  const paidAmountInput = document.getElementById("paid-amount-input");
  const paidAmount = parseFloat(paidAmountInput.value);

  if (!paidAmount || paidAmount <= 0) {
    return; // No paid amount entered yet
  }

  const totalSale = cart.reduce(
    (sum, item) => sum + item.salePrice * item.qty,
    0
  );

  if (paidAmount < totalSale) {
    paidAmountInput.style.borderColor = "red";
    paidAmountInput.style.borderWidth = "3px";
  } else {
    paidAmountInput.style.borderColor = "";
    paidAmountInput.style.borderWidth = "";
  }
}

function removeFromCart(index) {
  cart.splice(index, 1);
  updateCart();

  document.getElementById("paid-amount-input").value = "";
  document.getElementById("balance-display").style.display = "none";
}

function updateSummary() {
  const totalSale = cart.reduce(
    (sum, item) => sum + item.salePrice * item.qty,
    0
  );
  const totalItems = cart.length; // Number of item types, not total quantity

  document.getElementById("total-sale").textContent = `Rs. ${totalSale.toFixed(
    2
  )}`;
  document.getElementById("total-items").textContent = totalItems;
}

let lastOrderSaveTime = 0;
let lastPrintTime = 0;
let lastPaidAmountEnterTime = 0;
let clearFormTimeout = null;

function clearSalesForm() {
  // Clear the timeout if it exists
  if (clearFormTimeout) {
    clearTimeout(clearFormTimeout);
    clearFormTimeout = null;
  }

  cart = [];
  selectedProduct = null;
  currentSearchResultIndex = -1;

  document.getElementById("product-code-input").value = "";
  document.getElementById("paid-amount-input").value = "";
  document.getElementById("customer-name-input").value = "";
  document.getElementById("customer-mobile-input").value = "";
  document.getElementById("search-results-body").innerHTML = "";

  updateCart();

  document.getElementById("balance-display").style.display = "none";

  hideSelectedProductDetails();

  focusProductCodeInput();
}

document.getElementById("paid-amount-input").addEventListener("input", (e) => {
  const paidAmount = parseFloat(e.target.value);
  const totalSale = cart.reduce(
    (sum, item) => sum + item.salePrice * item.qty,
    0
  );

  if (!paidAmount || paidAmount <= 0) {
    document.getElementById("balance-display").style.display = "none";
    return;
  }

  const balance = paidAmount - totalSale;

  document.getElementById("balance-display").style.display = "flex";
  document.getElementById(
    "balance-amount"
  ).textContent = `Rs. ${balance.toFixed(2)}`;
  document.getElementById("balance-amount").style.color =
    balance >= 0 ? "#11998e" : "#eb3349";
});

document
  .getElementById("paid-amount-input")
  .addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();

      const currentTime = Date.now();

      // Check if this is a double Enter (within 500ms)
      if (currentTime - lastPaidAmountEnterTime < 500) {
        // Double Enter - print the already saved order
        lastPaidAmountEnterTime = 0; // Reset

        // Prevent spam printing
        if (currentTime - lastPrintTime < 1000) {
          return;
        }
        lastPrintTime = currentTime;

        // Print the last saved order and clear form immediately
        if (savedOrderId) {
          printBill(savedOrderId);
          clearSalesForm();
        }
      } else {
        // Single Enter - save only (don't clear yet, wait for possible second enter)
        lastPaidAmountEnterTime = currentTime;
        saveOrder(false); // Save without printing, without clearing

        // Set timeout to clear form after 600ms if no second enter
        if (clearFormTimeout) {
          clearTimeout(clearFormTimeout);
        }
        clearFormTimeout = setTimeout(() => {
          clearSalesForm();
        }, 600);
      }
    }
  });

document.getElementById("print-bill-btn").addEventListener("click", () => {
  saveOrder(true);
});

function showCustomBalancePopup() {
  const paidAmount =
    parseFloat(document.getElementById("paid-amount-input").value) || 0;
  const totalSale = cart.reduce(
    (sum, item) => sum + item.salePrice * item.qty,
    0
  );
  const balance = paidAmount - totalSale;

  const modal = document.getElementById("balance-modal");
  const balanceElement = document.getElementById("modal-balance");
  const closeBtn = document.getElementById("modal-close-btn");

  if (!modal || !balanceElement) {
    console.error("Modal elements not found!");
    return;
  }

  balanceElement.textContent = `Rs. ${balance.toFixed(2)}`;
  modal.style.display = "flex";

  const handleClose = () => {
    modal.style.display = "none";
    closeBtn.removeEventListener("click", handleClose);
    document.removeEventListener("keydown", handleKeyPress);

    cart = [];
    selectedProduct = null;
    currentSearchResultIndex = -1;

    document.getElementById("product-code-input").value = "";
    document.getElementById("paid-amount-input").value = "";
    document.getElementById("customer-name-input").value = "";
    document.getElementById("customer-mobile-input").value = "";

    document.getElementById("search-results-body").innerHTML = "";

    updateCart();

    document.getElementById("balance-display").style.display = "none";

    hideSelectedProductDetails();

    focusProductCodeInput();
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  closeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleClose();
  };

  document.addEventListener("keydown", handleKeyPress);

  setTimeout(() => {
    closeBtn.focus();
  }, 100);
}

function saveOrder(shouldPrint) {
  if (cart.length === 0) {
    showErrorModal("Cart is empty! Please add items to the cart.", () => {
      focusProductCodeInput();
    });
    return;
  }

  const isReturnMode = hasReturns();
  const totalSale = cart.reduce(
    (sum, item) => sum + item.salePrice * item.qty,
    0
  );

  let paidAmount = 0;
  let balance = 0;
  let isPaidOrder = false;

  const isPureReturnMode = isReturnMode && !hasSales();

  // For pure returns (no sales), skip payment validation
  if (!isPureReturnMode) {
    const paidAmountValue = document.getElementById("paid-amount-input").value.trim();

    // Allow empty paid amount (unpaid order) for sales or mixed carts
    if (paidAmountValue !== "") {
      paidAmount = parseFloat(paidAmountValue);

      if (!paidAmount || paidAmount <= 0) {
        showErrorModal("Please enter a valid paid amount or leave it empty for unpaid order!", () => {
          document.getElementById("paid-amount-input").focus();
        });
        return;
      }

      // Only validate paid amount if total sale is positive
      // For mixed carts with net negative total (more returns than sales), no validation needed
      if (totalSale > 0 && paidAmount < totalSale) {
        showErrorModal("Paid amount cannot be less than total sale amount!", () => {
          document.getElementById("paid-amount-input").focus();
        });
        return;
      }

      balance = paidAmount - totalSale;
      isPaidOrder = true;
    } else {
      // Empty paid amount - calculate balance for display
      balance = 0 - totalSale; // Negative if more returns than sales
    }
  } else {
    // For pure returns, total sale is negative (refund amount)
    paidAmount = 0;
    balance = 0;
  }

  const customerName = document
    .getElementById("customer-name-input")
    .value.trim();
  const customerMobile = document
    .getElementById("customer-mobile-input")
    .value.trim();

  try {
    if (customerName && customerMobile) {
      try {
        const checkCustomerStmt = db.prepare(
          "SELECT id FROM customers WHERE mobile = ?"
        );
        let customer = checkCustomerStmt.get(customerMobile);

        if (!customer) {
          const insertCustomerStmt = db.prepare(
            "INSERT INTO customers (name, mobile) VALUES (?, ?)"
          );
          insertCustomerStmt.run(customerName, customerMobile);
        } else {
          const updateCustomerStmt = db.prepare(
            "UPDATE customers SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE mobile = ?"
          );
          updateCustomerStmt.run(customerName, customerMobile);
        }
      } catch (customerError) {
        console.error("Customer save error:", customerError);
      }
    }

    const totalCost = cart.reduce((sum, item) => sum + item.cost * item.qty, 0);
    const totalProfit = totalSale - totalCost;

    const now = new Date();
    const localDateTime =
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0") +
      " " +
      String(now.getHours()).padStart(2, "0") +
      ":" +
      String(now.getMinutes()).padStart(2, "0") +
      ":" +
      String(now.getSeconds()).padStart(2, "0");

    const orderStmt = db.prepare(`
      INSERT INTO orders (customer_id, total_cost, total_sale_price, profit, customer_name, customer_mobile, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const orderResult = orderStmt.run(
      null,
      totalCost,
      totalSale,
      totalProfit,
      customerName || null,
      customerMobile || null,
      localDateTime
    );
    const orderId = orderResult.lastInsertRowid;
    savedOrderId = orderId;

    const orderItemStmt = db.prepare(`
      INSERT INTO order_items (order_id, product_id, quantity, cost_per_unit, sale_price_per_unit, total_cost, total_sale_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const updateQtyStmt = db.prepare(`
      UPDATE products SET qty = qty - ? WHERE id = ?
    `);

    cart.forEach((item) => {
      const itemTotalCost = item.cost * item.qty;
      const itemTotalSale = item.salePrice * item.qty;

      orderItemStmt.run(
        orderId,
        item.productId,
        item.qty,
        item.cost,
        item.salePrice,
        itemTotalCost,
        itemTotalSale
      );

      // For positive qty: subtract from stock (sale)
      // For negative qty: subtract negative (which adds to stock - return)
      updateQtyStmt.run(item.qty, item.productId);
    });

    // Print bill if requested and clear form immediately
    if (shouldPrint) {
      printBill(orderId);
      clearSalesForm();
    }
    // If not printing, form will be cleared by timeout or by second enter
  } catch (error) {
    showErrorModal("Error saving order: " + error.message, () => {
      focusProductCodeInput();
    });
  }
}

function printBill(orderId) {
  const orderStmt = db.prepare("SELECT * FROM orders WHERE id = ?");
  const order = orderStmt.get(orderId);

  const itemsStmt = db.prepare(`
    SELECT oi.*, p.product_code, p.product_name, p.sale_price as unit_price
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `);
  const items = itemsStmt.all(orderId);

  const paidAmountValue = document.getElementById("paid-amount-input").value.trim();
  const paidAmount = paidAmountValue !== "" ? parseFloat(paidAmountValue) : 0;
  const balance = paidAmount - order.total_sale_price;
  const totalItems = items.length;
  const isPaidOrder = paidAmountValue !== "" && paidAmount > 0;

  const now = new Date();
  const currentDate = now.toLocaleDateString("en-GB");
  const currentTime = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const billContent = `
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        @page {
          size: 72mm auto;
          margin: 0;
        }
        @media print {
          body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
        }
        body {
          width: 72mm;
          margin: 0;
          padding: 3mm 2mm;
          font-family: Arial, sans-serif;
          font-size: 13px;
          line-height: 1.5;
          color: #000;
        }
        .header {
          text-align: center;
          margin-bottom: 10px;
        }
        .header h1 {
          font-size: 20px;
          font-weight: bold;
          margin-bottom: 4px;
          letter-spacing: 1px;
        }
        .header p {
          font-size: 12px;
          margin: 2px 0;
        }
        .separator {
          border-top: 1px dashed #000;
          margin: 8px 0;
        }
        .bill-info {
          font-size: 12px;
          margin-bottom: 8px;
        }
        .bill-info div {
          margin: 3px 0;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          margin: 8px 0;
        }
        th {
          text-align: left;
          border-bottom: 1px solid #000;
          padding: 4px 2px;
          font-size: 12px;
          font-weight: bold;
        }
        td {
          padding: 4px 2px;
          vertical-align: top;
        }
        .text-right {
          text-align: right;
        }
        .text-center {
          text-align: center;
        }
        .summary {
          margin-top: 8px;
          font-size: 13px;
        }
        .summary-row {
          display: flex;
          justify-content: space-between;
          margin: 4px 0;
        }
        .grand-total {
          font-weight: bold;
          font-size: 18px;
          margin-top: 5px;
          border-top: 1px solid #000;
          padding-top: 5px;
        }
        .balance {
          font-size: 18px;
          font-weight: bold;
          text-align: center;
          margin: 12px 0;
        }
        .footer {
          text-align: center;
          font-size: 11px;
          margin-top: 10px;
        }
        .footer p {
          margin: 3px 0;
        }
        .system-info {
          text-align: center;
          font-size: 8px;
          margin-top: 10px;
          padding-top: 8px;
          border-top: 1px dashed #000;
        }
        .system-info p {
          margin: 1px 0;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>NEPTUNE MOBILE</h1>
        <p>Kurunegala Road, Padeniya</p>
        <p>Tel: 0760406698</p>
      </div>

      <div class="separator"></div>

      <div class="bill-info">
        <div style="display: flex; justify-content: space-between;">
          <span>Bill No: ${orderId}</span>
          <span>Customer: ${order.customer_name || "Walk-in"}</span>
        </div>
        <div>Date: ${currentDate} &nbsp; ${currentTime}</div>
      </div>

      <div class="separator"></div>

      <table>
        <thead>
          <tr>
            <th style="width: 15px;">#</th>
            <th>Item</th>
            <th class="text-center" style="width: 25px;">Qty</th>
            <th class="text-right" style="width: 40px;">Price</th>
            <th class="text-right" style="width: 50px;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (item, index) => {
                const isReturn = item.quantity < 0;
                const rowStyle = isReturn ? 'style="background-color: #ffe6cc;"' : '';
                const itemName = isReturn ? `${item.product_name} <strong style="color: #ff6600;">[RETURN]</strong>` : item.product_name;
                const qtyDisplay = isReturn ? `(${item.quantity})` : item.quantity;
                const totalDisplay = isReturn ? `(${item.total_sale_price.toFixed(2)})` : item.total_sale_price.toFixed(2);

                return `
            <tr ${rowStyle}>
              <td>${index + 1}</td>
              <td>${itemName}</td>
              <td class="text-center">${qtyDisplay}</td>
              <td class="text-right">${item.sale_price_per_unit.toFixed(2)}</td>
              <td class="text-right"><strong>${totalDisplay}</strong></td>
            </tr>
          `;
              }
            )
            .join("")}
        </tbody>
      </table>

      <div class="separator"></div>

      <div class="summary">
        <div class="summary-row grand-total">
          <span>Grand Total:</span>
          <span>Rs. ${order.total_sale_price.toFixed(2)}</span>
        </div>
        <div class="summary-row">
          <span>Items:</span>
          <span>${totalItems}</span>
        </div>
        ${isPaidOrder ? `
        <div class="summary-row">
          <span>Paid:</span>
          <span>Rs. ${paidAmount.toFixed(2)}</span>
        </div>
        ` : ''}
      </div>

      ${isPaidOrder ? `
      <div class="balance">
        Balance: Rs. ${balance.toFixed(2)}
      </div>
      ` : ''}

      <div class="separator"></div>

      <div class="footer">
        <p><strong>වගකීම් සඳහා බිල අත්‍යාවශ්‍ය වේ. ආපසු මුදල් ලබා නොදෙන බැවින් භාණඩ හොඳින් පරීක්ෂා කර බලා රැගෙන යන්න.
 ස්තූතියි නැවත එන්න</strong></p>
      </div>

      <div class="system-info">
        <p>System by ZipZipy PVT LTD</p>
        <p>Contact: 0788915271</p>
      </div>
    </body>
    </html>
  `;

  const { BrowserWindow } = require("@electron/remote");

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  printWindow.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(billContent)
  );

  printWindow.webContents.on("did-finish-load", () => {
    printWindow.webContents.print(
      {
        silent: true,
        printBackground: true,
        color: true,
        margins: {
          marginType: "none",
        },
        pageSize: {
          width: 72000,
          height: 297000,
        },
        scaleFactor: 100,
        landscape: false,
      },
      (success, errorType) => {
        if (!success) {
          console.error("Print failed:", errorType);
        }
        printWindow.close();
      }
    );
  });
}

function updateDailySummary(totalCost, totalSale, totalProfit) {
  const today = new Date().toISOString().split("T")[0];

  const checkStmt = db.prepare(
    "SELECT * FROM daily_summary WHERE summary_date = ?"
  );
  const existing = checkStmt.get(today);

  if (existing) {
    const updateStmt = db.prepare(`
      UPDATE daily_summary
      SET total_cost = total_cost + ?,
          total_sale_price = total_sale_price + ?,
          total_profit = total_profit + ?
      WHERE summary_date = ?
    `);
    updateStmt.run(totalCost, totalSale, totalProfit, today);
  } else {
    const insertStmt = db.prepare(`
      INSERT INTO daily_summary (summary_date, total_cost, total_sale_price, total_profit)
      VALUES (?, ?, ?, ?)
    `);
    insertStmt.run(today, totalCost, totalSale, totalProfit);
  }
}

let grnSearchQuery = "";
let grnFilterType = "all";

function loadGRNTable() {
  let query = "SELECT * FROM products";
  let params = [];
  let whereConditions = [];

  if (grnSearchQuery) {
    whereConditions.push("(LOWER(product_code) LIKE ? OR LOWER(product_name) LIKE ?)");
    params.push(`%${grnSearchQuery.toLowerCase()}%`, `%${grnSearchQuery.toLowerCase()}%`);
  }

  if (grnFilterType === "low-stock") {
    whereConditions.push("qty < 5 AND qty > 0");
  } else if (grnFilterType === "out-of-stock") {
    whereConditions.push("qty = 0");
  }

  if (whereConditions.length > 0) {
    query += " WHERE " + whereConditions.join(" AND ");
  }

  query += " ORDER BY id ASC";

  const stmt = db.prepare(query);
  const products = params.length > 0 ? stmt.all(...params) : stmt.all();

  const totalItems = products.length;
  const totalValue = products.reduce(
    (sum, product) => sum + product.cost * product.qty,
    0
  );

  document.getElementById("grn-total-items").textContent = totalItems;
  document.getElementById(
    "grn-total-value"
  ).textContent = `Rs. ${totalValue.toFixed(2)}`;

  const tbody = document.getElementById("grn-items");
  tbody.innerHTML = products
    .map((product) => {
      const updatedDate = new Date(product.updated_at || product.created_at);
      const formattedDate = updatedDate.toLocaleDateString("en-GB");
      const formattedTime = updatedDate.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      });

      return `
    <tr>
      <td>${product.id}</td>
      <td>${product.product_code}</td>
      <td>
        <input type="text"
               value="${product.product_name.replace(/"/g, '&quot;')}"
               data-original="${product.product_name.replace(/"/g, '&quot;')}"
               data-product-id="${product.id}"
               onchange="confirmUpdateProductName(this)"
               class="grn-name-input">
      </td>
      <td>
        <input type="number"
               value="${product.cost}"
               data-original="${product.cost}"
               data-product-id="${product.id}"
               data-qty="${product.qty}"
               data-sale-price="${product.sale_price}"
               min="0.01"
               step="0.01"
               onchange="confirmUpdateProductCost(this)"
               class="grn-cost-input">
      </td>
      <td>
        <input type="number"
               value="${product.qty}"
               data-original="${product.qty}"
               data-product-id="${product.id}"
               data-cost="${product.cost}"
               min="0"
               step="1"
               onchange="confirmUpdateProductQty(this)"
               class="grn-qty-input">
      </td>
      <td class="cost-qty-total" data-product-id="${product.id}">Rs. ${(product.cost * product.qty).toFixed(2)}</td>
      <td>
        <input type="number"
               value="${product.sale_price}"
               data-original="${product.sale_price}"
               data-product-id="${product.id}"
               data-cost="${product.cost}"
               min="${product.cost}"
               step="0.01"
               onchange="confirmUpdateProductSalePrice(this)"
               class="grn-price-input">
      </td>
      <td style="font-size: 0.9rem;">${formattedDate} ${formattedTime}</td>
      <td>
        <button class="btn-delete" onclick="confirmDeleteProduct(${product.id}, '${product.product_name.replace(/'/g, "\\'")}')">Delete</button>
      </td>
    </tr>
  `;
    })
    .join("");
}

document.getElementById("grn-search-input").addEventListener("input", (e) => {
  grnSearchQuery = e.target.value.trim();
  loadGRNTable();
});

document.getElementById("grn-filter-select").addEventListener("change", (e) => {
  grnFilterType = e.target.value;
  loadGRNTable();
});

document.getElementById("grn-report-btn").addEventListener("click", () => {
  printGRNReport();
});

function printGRNReport() {
  // Get the current filtered products
  let query = "SELECT * FROM products";
  let params = [];
  let whereConditions = [];

  if (grnSearchQuery) {
    whereConditions.push("(LOWER(product_code) LIKE ? OR LOWER(product_name) LIKE ?)");
    params.push(`%${grnSearchQuery.toLowerCase()}%`, `%${grnSearchQuery.toLowerCase()}%`);
  }

  if (grnFilterType === "low-stock") {
    whereConditions.push("qty < 5 AND qty > 0");
  } else if (grnFilterType === "out-of-stock") {
    whereConditions.push("qty = 0");
  }

  if (whereConditions.length > 0) {
    query += " WHERE " + whereConditions.join(" AND ");
  }

  query += " ORDER BY product_code ASC";

  const stmt = db.prepare(query);
  const products = params.length > 0 ? stmt.all(...params) : stmt.all();

  if (products.length === 0) {
    showErrorModal("No products to print in the current view!");
    return;
  }

  const now = new Date();
  const currentDate = now.toLocaleDateString("en-GB");
  const currentTime = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const totalValue = products.reduce((sum, product) => sum + product.cost * product.qty, 0);
  const totalQty = products.reduce((sum, product) => sum + product.qty, 0);

  let reportTitle = "GRN Report - All Products";
  if (grnFilterType === "low-stock") {
    reportTitle = "GRN Report - Low Stock (Qty < 5)";
  } else if (grnFilterType === "out-of-stock") {
    reportTitle = "GRN Report - Out of Stock";
  }

  const reportContent = `
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        @page {
          size: 72mm auto;
          margin: 0;
        }
        @media print {
          body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
        }
        body {
          width: 72mm;
          margin: 0;
          padding: 3mm 2mm;
          font-family: Arial, sans-serif;
          font-size: 11px;
          line-height: 1.4;
          color: #000;
        }
        .header {
          text-align: center;
          margin-bottom: 8px;
        }
        .header h1 {
          font-size: 18px;
          font-weight: bold;
          margin-bottom: 3px;
          letter-spacing: 0.5px;
        }
        .header p {
          font-size: 10px;
          margin: 2px 0;
        }
        .separator {
          border-top: 1px dashed #000;
          margin: 6px 0;
        }
        .report-title {
          text-align: center;
          font-weight: bold;
          font-size: 12px;
          margin: 8px 0;
        }
        .report-info {
          font-size: 10px;
          margin-bottom: 6px;
        }
        .report-info div {
          margin: 2px 0;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 9px;
          margin: 6px 0;
        }
        th {
          text-align: left;
          border-bottom: 1px solid #000;
          padding: 3px 1px;
          font-size: 9px;
          font-weight: bold;
        }
        td {
          padding: 3px 1px;
          vertical-align: top;
          border-bottom: 1px dotted #ccc;
        }
        .text-right {
          text-align: right;
        }
        .summary {
          margin-top: 6px;
          font-size: 11px;
          border-top: 1px solid #000;
          padding-top: 5px;
        }
        .summary-row {
          display: flex;
          justify-content: space-between;
          margin: 3px 0;
        }
        .summary-row.total {
          font-weight: bold;
          font-size: 12px;
          margin-top: 4px;
        }
        .footer {
          text-align: center;
          font-size: 9px;
          margin-top: 8px;
          padding-top: 6px;
          border-top: 1px dashed #000;
        }
        .footer p {
          margin: 2px 0;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>NEPTUNE MOBILE</h1>
        <p>Kurunegala Road, Padeniya</p>
        <p>Tel: 0760406698</p>
      </div>

      <div class="separator"></div>

      <div class="report-title">${reportTitle}</div>

      <div class="report-info">
        <div>Date: ${currentDate} &nbsp; ${currentTime}</div>
        <div>Total Products: ${products.length}</div>
      </div>

      <div class="separator"></div>

      <table>
        <thead>
          <tr>
            <th style="width: 15%;">Code</th>
            <th style="width: 30%;">Name</th>
            <th class="text-right" style="width: 10%;">Qty</th>
            <th class="text-right" style="width: 20%;">Cost</th>
            <th class="text-right" style="width: 25%;">Selling</th>
          </tr>
        </thead>
        <tbody>
          ${products
            .map(
              (product) => `
            <tr>
              <td>${product.product_code}</td>
              <td>${product.product_name}</td>
              <td class="text-right">${product.qty}</td>
              <td class="text-right">${product.cost.toFixed(2)}</td>
              <td class="text-right">${product.sale_price.toFixed(2)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>

      <div class="summary">
        <div class="summary-row">
          <span>Total Items:</span>
          <span>${products.length}</span>
        </div>
        <div class="summary-row">
          <span>Total Quantity:</span>
          <span>${totalQty}</span>
        </div>
        <div class="summary-row total">
          <span>Total Stock Value:</span>
          <span>Rs. ${totalValue.toFixed(2)}</span>
        </div>
      </div>

      <div class="footer">
        <p>System by ZipZipy PVT LTD</p>
        <p>Contact: 0788915271</p>
      </div>
    </body>
    </html>
  `;

  const { BrowserWindow } = require("@electron/remote");

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  printWindow.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(reportContent)
  );

  printWindow.webContents.on("did-finish-load", () => {
    printWindow.webContents.print(
      {
        silent: true,
        printBackground: true,
        color: true,
        margins: {
          marginType: "none",
        },
        pageSize: {
          width: 72000,
          height: 297000,
        },
        scaleFactor: 100,
        landscape: false,
      },
      (success, errorType) => {
        if (!success) {
          console.error("Print failed:", errorType);
        }
        printWindow.close();
      }
    );
  });
}

function confirmDeleteProduct(productId, productName) {
  showConfirmModal(
    "Delete Product",
    `Are you sure you want to delete "${productName}"? This action cannot be undone.`,
    () => {
      deleteProduct(productId);
    },
    null
  );
}

function deleteProduct(productId) {
  try {
    // Check if product has been sold
    const checkSoldStmt = db.prepare(`
      SELECT COUNT(*) as count FROM order_items WHERE product_id = ?
    `);
    const soldResult = checkSoldStmt.get(productId);

    if (soldResult.count > 0) {
      showErrorModal("Cannot delete product! This product has sales history.");
      return;
    }

    const deleteStmt = db.prepare("DELETE FROM products WHERE id = ?");
    deleteStmt.run(productId);

    showSuccessModal("Product deleted successfully!", () => {
      loadGRNTable();
    });
  } catch (error) {
    showErrorModal("Error deleting product: " + error.message);
  }
}

function showGRNConfirmModal(message, oldValue, newValue, onYes, onNo) {
  const modal = document.getElementById("grn-confirm-modal");
  const messageElement = document.getElementById("grn-confirm-message");
  const oldValueElement = document.getElementById("grn-old-value");
  const newValueElement = document.getElementById("grn-new-value");
  const yesBtn = document.getElementById("grn-confirm-yes-btn");
  const noBtn = document.getElementById("grn-confirm-no-btn");

  messageElement.textContent = message;
  oldValueElement.textContent = oldValue;
  newValueElement.textContent = newValue;
  modal.style.display = "flex";

  const handleYes = () => {
    modal.style.display = "none";
    yesBtn.removeEventListener("click", handleYes);
    noBtn.removeEventListener("click", handleNo);
    document.removeEventListener("keydown", handleKeyPress);
    if (onYes) onYes();
  };

  const handleNo = () => {
    modal.style.display = "none";
    yesBtn.removeEventListener("click", handleYes);
    noBtn.removeEventListener("click", handleNo);
    document.removeEventListener("keydown", handleKeyPress);
    if (onNo) onNo();
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleYes();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleNo();
    }
  };

  yesBtn.addEventListener("click", (e) => {
    e.target.blur();
    handleYes();
  });
  noBtn.addEventListener("click", (e) => {
    e.target.blur();
    handleNo();
  });
  document.addEventListener("keydown", handleKeyPress);

  setTimeout(() => yesBtn.focus(), 100);
}

function confirmUpdateProductQty(inputElement) {
  const productId = parseInt(inputElement.dataset.productId);
  const newQty = parseInt(inputElement.value);
  const originalQty = parseInt(inputElement.dataset.original);

  if (newQty === originalQty) {
    return;
  }

  if (isNaN(newQty) || newQty < 0) {
    showErrorModal("Quantity must be 0 or greater!", () => {
      inputElement.value = originalQty;
    });
    return;
  }

  showGRNConfirmModal(
    "Update Product Quantity?",
    originalQty,
    newQty,
    () => {
      updateProductQty(productId, newQty);
    },
    () => {
      inputElement.value = originalQty;
    }
  );
}

function confirmUpdateProductSalePrice(inputElement) {
  const productId = parseInt(inputElement.dataset.productId);
  const newPrice = parseFloat(inputElement.value);
  const originalPrice = parseFloat(inputElement.dataset.original);
  const cost = parseFloat(inputElement.dataset.cost);

  if (newPrice === originalPrice) {
    return;
  }

  if (isNaN(newPrice) || newPrice <= 0) {
    showErrorModal("Sale price must be greater than 0!", () => {
      inputElement.value = originalPrice;
    });
    return;
  }

  if (newPrice < cost) {
    showErrorModal(
      `Sale price cannot be less than cost price (Rs. ${cost.toFixed(2)})!`,
      () => {
        inputElement.value = originalPrice;
      }
    );
    return;
  }

  showGRNConfirmModal(
    "Update Selling Price?",
    `Rs. ${originalPrice.toFixed(2)}`,
    `Rs. ${newPrice.toFixed(2)}`,
    () => {
      updateProductSalePrice(productId, newPrice, cost);
    },
    () => {
      inputElement.value = originalPrice;
    }
  );
}

function updateProductQty(productId, newQty) {
  const qty = parseInt(newQty);

  if (isNaN(qty) || qty < 0) {
    showErrorModal("Quantity must be 0 or greater!", () => {
      loadGRNTable();
    });
    return;
  }

  try {
    const updateStmt = db.prepare(
      "UPDATE products SET qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    updateStmt.run(qty, productId);

    // Update the Cost × Qty display immediately after database update
    const qtyInput = document.querySelector(`.grn-qty-input[data-product-id="${productId}"]`);
    if (qtyInput) {
      const cost = parseFloat(qtyInput.dataset.cost);
      const costQtyCell = document.querySelector(`.cost-qty-total[data-product-id="${productId}"]`);
      if (costQtyCell) {
        costQtyCell.textContent = `Rs. ${(cost * qty).toFixed(2)}`;
      }
      qtyInput.dataset.original = qty;
    }

    loadGRNTable();
  } catch (error) {
    showErrorModal("Error updating quantity: " + error.message);
  }
}

function updateProductSalePrice(productId, newPrice, cost) {
  const price = parseFloat(newPrice);

  if (isNaN(price) || price <= 0) {
    showErrorModal("Sale price must be greater than 0!", () => {
      loadGRNTable();
    });
    return;
  }

  if (price < cost) {
    showErrorModal(
      `Sale price cannot be less than cost price (Rs. ${cost.toFixed(2)})!`,
      () => {
        loadGRNTable();
      }
    );
    return;
  }

  try {
    const updateStmt = db.prepare(
      "UPDATE products SET sale_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    updateStmt.run(price, productId);
    loadGRNTable();
  } catch (error) {
    showErrorModal("Error updating sale price: " + error.message);
  }
}

function confirmUpdateProductName(inputElement) {
  const productId = parseInt(inputElement.dataset.productId);
  const newName = inputElement.value.trim();
  const originalName = inputElement.dataset.original;

  if (newName === originalName) {
    return;
  }

  if (!newName || newName.length === 0) {
    showErrorModal("Product name cannot be empty!", () => {
      inputElement.value = originalName;
    });
    return;
  }

  showGRNConfirmModal(
    "Update Product Name?",
    originalName,
    newName,
    () => {
      updateProductName(productId, newName);
    },
    () => {
      inputElement.value = originalName;
    }
  );
}

function updateProductName(productId, newName) {
  const name = newName.trim();

  if (!name || name.length === 0) {
    showErrorModal("Product name cannot be empty!", () => {
      loadGRNTable();
    });
    return;
  }

  try {
    const updateStmt = db.prepare(
      "UPDATE products SET product_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    updateStmt.run(name, productId);
    loadGRNTable();
  } catch (error) {
    showErrorModal("Error updating product name: " + error.message);
  }
}

function confirmUpdateProductCost(inputElement) {
  const productId = parseInt(inputElement.dataset.productId);
  const newCost = parseFloat(inputElement.value);
  const originalCost = parseFloat(inputElement.dataset.original);
  const qty = parseInt(inputElement.dataset.qty);
  const salePrice = parseFloat(inputElement.dataset.salePrice);

  if (newCost === originalCost) {
    return;
  }

  if (isNaN(newCost) || newCost <= 0) {
    showErrorModal("Cost price must be greater than 0!", () => {
      inputElement.value = originalCost;
    });
    return;
  }

  if (newCost > salePrice) {
    showErrorModal(
      `Cost price cannot be greater than selling price (Rs. ${salePrice.toFixed(2)})!\nPlease update the selling price first.`,
      () => {
        inputElement.value = originalCost;
      }
    );
    return;
  }

  showGRNConfirmModal(
    "Update Cost Price?",
    `Rs. ${originalCost.toFixed(2)}`,
    `Rs. ${newCost.toFixed(2)}`,
    () => {
      updateProductCost(productId, newCost, qty);
    },
    () => {
      inputElement.value = originalCost;
    }
  );
}

function updateProductCost(productId, newCost, qty) {
  const cost = parseFloat(newCost);

  if (isNaN(cost) || cost <= 0) {
    showErrorModal("Cost price must be greater than 0!", () => {
      loadGRNTable();
    });
    return;
  }

  try {
    const updateStmt = db.prepare(
      "UPDATE products SET cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    updateStmt.run(cost, productId);

    // Update the Cost × Qty display immediately after database update
    const costQtyCell = document.querySelector(`.cost-qty-total[data-product-id="${productId}"]`);
    if (costQtyCell) {
      costQtyCell.textContent = `Rs. ${(cost * qty).toFixed(2)}`;
    }

    // Update the minimum value for the selling price input
    const salePriceInput = document.querySelector(`.grn-price-input[data-product-id="${productId}"]`);
    if (salePriceInput) {
      salePriceInput.setAttribute('min', cost);
      salePriceInput.dataset.cost = cost;
    }

    // Update the cost data attribute on qty input
    const qtyInput = document.querySelector(`.grn-qty-input[data-product-id="${productId}"]`);
    if (qtyInput) {
      qtyInput.dataset.cost = cost;
    }

    // Update the cost input's original value
    const costInput = document.querySelector(`.grn-cost-input[data-product-id="${productId}"]`);
    if (costInput) {
      costInput.dataset.original = cost;
    }

    loadGRNTable();
  } catch (error) {
    showErrorModal("Error updating cost price: " + error.message);
  }
}

document.getElementById("add-product-btn").addEventListener("click", () => {
  const modal = document.getElementById("add-product-modal");
  modal.style.display = "flex";

  document.getElementById("add-product-form").reset();

  setTimeout(() => {
    document.getElementById("new-product-code").focus();
  }, 100);
});

document.getElementById("new-product-code").addEventListener("blur", (e) => {
  const productCode = e.target.value.trim();

  if (!productCode) {
    return;
  }

  // Check if product code already exists
  try {
    const checkStmt = db.prepare("SELECT COUNT(*) as count FROM products WHERE product_code = ?");
    const result = checkStmt.get(productCode);

    if (result.count > 0) {
      showErrorModal(`Product code "${productCode}" already exists! Please use a different code.`, () => {
        document.getElementById("new-product-code").value = "";
        document.getElementById("new-product-code").focus();
      });
    }
  } catch (error) {
    console.error("Error checking product code:", error);
  }
});

document.getElementById("new-product-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const value = e.target.value.trim();
    if (value) {
      document.getElementById("new-product-name").focus();
    }
  }
});

document.getElementById("new-product-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const value = e.target.value.trim();
    if (value) {
      document.getElementById("new-product-cost").focus();
    }
  }
});

document.getElementById("new-product-cost").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const value = parseFloat(e.target.value);
    if (!isNaN(value) && value > 0) {
      document.getElementById("new-product-qty").focus();
    }
  }
});

document.getElementById("new-product-qty").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const value = parseInt(e.target.value);
    if (!isNaN(value) && value > 0) {
      document.getElementById("new-product-sale-price").focus();
    }
  }
});

document
  .getElementById("new-product-sale-price")
  .addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const value = parseFloat(e.target.value);
      if (!isNaN(value) && value > 0) {
        addNewProduct();
      }
    }
  });

document
  .getElementById("add-product-submit-btn")
  .addEventListener("click", (e) => {
    e.preventDefault();
    addNewProduct();
  });

function addNewProduct() {
  const productCode = document.getElementById("new-product-code").value.trim();
  const productName = document.getElementById("new-product-name").value.trim();
  const cost = parseFloat(document.getElementById("new-product-cost").value);
  const qty = parseInt(document.getElementById("new-product-qty").value);
  const salePrice = parseFloat(
    document.getElementById("new-product-sale-price").value
  );

  if (!productCode) {
    showErrorModal("Please enter product code!");
    return;
  }

  if (!productName) {
    showErrorModal("Please enter product name!");
    return;
  }

  if (isNaN(cost) || cost <= 0) {
    showErrorModal("Cost price must be greater than 0!");
    return;
  }

  if (isNaN(qty) || qty <= 0) {
    showErrorModal("Quantity must be greater than 0!");
    return;
  }

  if (isNaN(salePrice) || salePrice <= 0) {
    showErrorModal("Selling price must be greater than 0!");
    return;
  }

  if (salePrice < cost) {
    showErrorModal("Selling price cannot be less than cost price!");
    return;
  }

  try {
    const insertStmt = db.prepare(`
      INSERT INTO products (product_code, product_name, cost, qty, sale_price)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertStmt.run(productCode, productName, cost, qty, salePrice);

    document.getElementById("add-product-form").reset();

    loadGRNTable();

    setTimeout(() => {
      document.getElementById("new-product-code").focus();
    }, 100);
  } catch (error) {
    if (error.message.includes("UNIQUE constraint failed")) {
      showErrorModal("Product code already exists!");
    } else {
      showErrorModal("Error adding product: " + error.message);
    }
  }
}

document
  .getElementById("add-product-cancel-btn")
  .addEventListener("click", () => {
    document.getElementById("add-product-modal").style.display = "none";
  });

let salesChart = null;
let profitChart = null;
let monthlyChart = null;

function loadAnalytics() {
  loadIncomeData();
  loadSalesCharts();
}

function loadIncomeData() {
  const today = new Date();

  const dailyStmt = db.prepare(`
    SELECT SUM(profit) as total_profit
    FROM orders
    WHERE DATE(created_at) = DATE('now')
  `);
  const dailyData = dailyStmt.get();
  document.getElementById("daily-income").textContent = `Rs. ${(
    dailyData.total_profit || 0
  ).toFixed(2)}`;

  const weeklyStmt = db.prepare(`
    SELECT SUM(profit) as total_profit
    FROM orders
    WHERE DATE(created_at) >= DATE('now', '-7 days')
  `);
  const weeklyData = weeklyStmt.get();
  document.getElementById("weekly-income").textContent = `Rs. ${(
    weeklyData.total_profit || 0
  ).toFixed(2)}`;

  const monthlyStmt = db.prepare(`
    SELECT SUM(profit) as total_profit
    FROM orders
    WHERE DATE(created_at) >= DATE('now', 'start of month')
  `);
  const monthlyData = monthlyStmt.get();
  document.getElementById("monthly-income").textContent = `Rs. ${(
    monthlyData.total_profit || 0
  ).toFixed(2)}`;

  const yearlyStmt = db.prepare(`
    SELECT SUM(profit) as total_profit
    FROM orders
    WHERE DATE(created_at) >= DATE('now', 'start of year')
  `);
  const yearlyData = yearlyStmt.get();
  document.getElementById("yearly-income").textContent = `Rs. ${(
    yearlyData.total_profit || 0
  ).toFixed(2)}`;
}

function loadSalesCharts() {
  const last7DaysStmt = db.prepare(`
    SELECT
      DATE(created_at) as date,
      SUM(total_sale_price) as total_sales,
      SUM(total_cost) as total_cost,
      SUM(profit) as total_profit
    FROM orders
    WHERE DATE(created_at) >= DATE('now', '-7 days')
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at)
  `);
  const last7DaysData = last7DaysStmt.all();

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    last7Days.push(date.toISOString().split("T")[0]);
  }

  const salesData = last7Days.map((date) => {
    const found = last7DaysData.find((d) => d.date === date);
    return found ? found.total_sales : 0;
  });

  const costData = last7Days.map((date) => {
    const found = last7DaysData.find((d) => d.date === date);
    return found ? found.total_cost : 0;
  });

  const labels = last7Days.map((date) => {
    const d = new Date(date);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  });

  if (salesChart) {
    salesChart.destroy();
  }

  const salesCtx = document.getElementById("sales-chart").getContext("2d");
  salesChart = new Chart(salesCtx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Sales",
          data: salesData,
          borderColor: "#0891b2",
          backgroundColor: "rgba(8, 145, 178, 0.1)",
          tension: 0.4,
          fill: true,
        },
        {
          label: "Cost",
          data: costData,
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245, 158, 11, 0.1)",
          tension: 0.4,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: true,
          position: "top",
        },
      },
      scales: {
        y: {
          beginAtZero: true,
        },
      },
    },
  });

  const totalStmt = db.prepare(`
    SELECT
      SUM(total_cost) as total_cost,
      SUM(total_sale_price) as total_sales,
      SUM(profit) as total_profit
    FROM orders
    WHERE DATE(created_at) >= DATE('now', '-30 days')
  `);
  const totalData = totalStmt.get();

  if (profitChart) {
    profitChart.destroy();
  }

  const profitCtx = document.getElementById("profit-chart").getContext("2d");
  profitChart = new Chart(profitCtx, {
    type: "bar",
    data: {
      labels: ["Last 30 Days"],
      datasets: [
        {
          label: "Total Cost",
          data: [totalData.total_cost || 0],
          backgroundColor: "#f59e0b",
        },
        {
          label: "Total Sales",
          data: [totalData.total_sales || 0],
          backgroundColor: "#0891b2",
        },
        {
          label: "Total Profit",
          data: [totalData.total_profit || 0],
          backgroundColor: "#059669",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: true,
          position: "top",
        },
      },
      scales: {
        y: {
          beginAtZero: true,
        },
      },
    },
  });

  const monthlyTrendStmt = db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) as month,
      SUM(total_sale_price) as total_sales,
      SUM(profit) as total_profit
    FROM orders
    WHERE DATE(created_at) >= DATE('now', '-12 months')
    GROUP BY strftime('%Y-%m', created_at)
    ORDER BY month
  `);
  const monthlyTrendData = monthlyTrendStmt.all();

  const monthLabels = monthlyTrendData.map((d) => {
    const [year, month] = d.month.split("-");
    const date = new Date(year, month - 1);
    return date.toLocaleDateString("en-GB", {
      month: "short",
      year: "numeric",
    });
  });

  const monthlySalesData = monthlyTrendData.map((d) => d.total_sales);
  const monthlyProfitData = monthlyTrendData.map((d) => d.total_profit);

  if (monthlyChart) {
    monthlyChart.destroy();
  }

  const monthlyCtx = document.getElementById("monthly-chart").getContext("2d");
  monthlyChart = new Chart(monthlyCtx, {
    type: "bar",
    data: {
      labels: monthLabels,
      datasets: [
        {
          label: "Sales",
          data: monthlySalesData,
          backgroundColor: "#0891b2",
        },
        {
          label: "Profit",
          data: monthlyProfitData,
          backgroundColor: "#059669",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: true,
          position: "top",
        },
      },
      scales: {
        y: {
          beginAtZero: true,
        },
      },
    },
  });
}

let currentReportPeriod = "daily";

document.querySelectorAll(".period-tab").forEach((tab) => {
  tab.addEventListener("click", function () {
    document
      .querySelectorAll(".period-tab")
      .forEach((t) => t.classList.remove("active"));
    this.classList.add("active");

    currentReportPeriod = this.dataset.period;
    loadReportByPeriod(currentReportPeriod);
  });
});

function loadReportByPeriod(period) {
  const today = new Date();
  let fromDate, toDate;

  if (period === "daily") {
    fromDate = toDate = today.toISOString().split("T")[0];
  } else if (period === "weekly") {
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);
    fromDate = weekAgo.toISOString().split("T")[0];
    toDate = today.toISOString().split("T")[0];
  } else if (period === "monthly") {
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    fromDate = firstDayOfMonth.toISOString().split("T")[0];
    toDate = today.toISOString().split("T")[0];
  } else if (period === "yearly") {
    const firstDayOfYear = new Date(today.getFullYear(), 0, 1);
    fromDate = firstDayOfYear.toISOString().split("T")[0];
    toDate = today.toISOString().split("T")[0];
  }

  document.getElementById("report-from").value = fromDate;
  document.getElementById("report-to").value = toDate;

  generateReport(fromDate, toDate);
}

function loadDailyReport() {
  loadReportByPeriod("daily");
}

function generateReport(fromDate, toDate) {
  const reportStmt = db.prepare(`
    SELECT
      p.product_code,
      p.product_name,
      oi.quantity as total_qty,
      oi.cost_per_unit,
      oi.sale_price_per_unit,
      oi.total_cost,
      oi.total_sale_price,
      (oi.total_sale_price - oi.total_cost) as profit,
      o.created_at as order_date
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE DATE(o.created_at) BETWEEN ? AND ?
    ORDER BY o.created_at ASC, oi.id ASC
  `);

  const reportData = reportStmt.all(fromDate, toDate);

  const tbody = document.getElementById("report-items");
  tbody.innerHTML = reportData
    .map(
      (item) => {
        // Check if this is a return (negative quantity)
        const isReturn = item.total_qty < 0;
        const rowStyle = isReturn ? 'style="background-color: #ffebe6; border-left: 3px solid #ff6b6b;"' : '';

        return `
    <tr ${rowStyle}>
      <td>${item.product_code}</td>
      <td>${item.product_name}</td>
      <td>${item.total_qty}</td>
      <td>Rs. ${item.cost_per_unit.toFixed(2)}</td>
      <td>Rs. ${item.sale_price_per_unit.toFixed(2)}</td>
      <td>Rs. ${item.total_cost.toFixed(2)}</td>
      <td>Rs. ${item.total_sale_price.toFixed(2)}</td>
      <td>Rs. ${item.profit.toFixed(2)}</td>
    </tr>
  `;
      }
    )
    .join("");

  const totalCostQty = reportData.reduce(
    (sum, item) => sum + item.total_cost,
    0
  );
  const totalSoldQty = reportData.reduce(
    (sum, item) => sum + item.total_sale_price,
    0
  );
  const totalProfit = reportData.reduce((sum, item) => sum + item.profit, 0);

  document.getElementById(
    "total-cost-qty"
  ).textContent = `Rs. ${totalCostQty.toFixed(2)}`;
  document.getElementById(
    "total-sold-qty"
  ).textContent = `Rs. ${totalSoldQty.toFixed(2)}`;
  document.getElementById(
    "total-profit"
  ).textContent = `Rs. ${totalProfit.toFixed(2)}`;
}

document.getElementById("generate-report").addEventListener("click", () => {
  const fromDate = document.getElementById("report-from").value;
  const toDate = document.getElementById("report-to").value;

  if (!fromDate || !toDate) {
    showErrorModal("Please select both From and To dates!");
    return;
  }

  if (fromDate > toDate) {
    showErrorModal("From date cannot be greater than To date!");
    return;
  }

  generateReport(fromDate, toDate);
});

// Report Print Functions

function getReportDateRange() {
  const fromDate = document.getElementById("report-from").value;
  const toDate = document.getElementById("report-to").value;

  if (!fromDate || !toDate) {
    showErrorModal("Please generate a report first by selecting date range!");
    return null;
  }

  return { fromDate, toDate };
}

// 1. Daily Summary Report - Overview of sales, returns, profit
document.getElementById("print-daily-summary").addEventListener("click", () => {
  const dates = getReportDateRange();
  if (!dates) return;

  printDailySummaryReport(dates.fromDate, dates.toDate);
});

function printDailySummaryReport(fromDate, toDate) {
  // Get summary data
  const summaryStmt = db.prepare(`
    SELECT
      COUNT(DISTINCT o.id) as total_orders,
      SUM(CASE WHEN oi.quantity > 0 THEN oi.quantity ELSE 0 END) as total_items_sold,
      SUM(CASE WHEN oi.quantity < 0 THEN ABS(oi.quantity) ELSE 0 END) as total_items_returned,
      SUM(oi.total_cost) as total_cost,
      SUM(oi.total_sale_price) as total_revenue,
      SUM(oi.total_sale_price - oi.total_cost) as total_profit
    FROM orders o
    JOIN order_items oi ON o.id = oi.order_id
    WHERE DATE(o.created_at) BETWEEN ? AND ?
  `);

  const summary = summaryStmt.get(fromDate, toDate);

  const now = new Date();
  const printTime = now.toLocaleString("en-GB");

  const billContent = `
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: 72mm auto; margin: 0; }
        body {
          width: 72mm;
          margin: 0;
          padding: 3mm 2mm;
          font-family: Arial, sans-serif;
          font-size: 12px;
          line-height: 1.4;
        }
        .header {
          text-align: center;
          margin-bottom: 10px;
        }
        .header h1 {
          font-size: 18px;
          font-weight: bold;
          margin-bottom: 3px;
        }
        .header p {
          font-size: 11px;
          margin: 2px 0;
        }
        .separator {
          border-top: 1px dashed #000;
          margin: 8px 0;
        }
        .section-title {
          font-weight: bold;
          font-size: 13px;
          margin: 8px 0 5px 0;
          text-align: center;
        }
        .summary-row {
          display: flex;
          justify-content: space-between;
          margin: 4px 0;
          font-size: 12px;
        }
        .summary-row.total {
          font-weight: bold;
          font-size: 14px;
          margin-top: 8px;
          padding-top: 6px;
          border-top: 1px solid #000;
        }
        .footer {
          text-align: center;
          font-size: 9px;
          margin-top: 12px;
          padding-top: 8px;
          border-top: 1px dashed #000;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>NEPTUNE MOBILE</h1>
        <p>DAILY SALES SUMMARY</p>
        <p>${fromDate === toDate ? fromDate : fromDate + ' to ' + toDate}</p>
        <p style="font-size: 9px;">Printed: ${printTime}</p>
      </div>

      <div class="separator"></div>

      <div class="section-title">SALES OVERVIEW</div>

      <div class="summary-row">
        <span>Total Orders:</span>
        <span>${summary.total_orders || 0}</span>
      </div>
      <div class="summary-row">
        <span>Items Sold:</span>
        <span>${summary.total_items_sold || 0}</span>
      </div>
      <div class="summary-row">
        <span>Items Returned:</span>
        <span>${summary.total_items_returned || 0}</span>
      </div>

      <div class="separator"></div>

      <div class="section-title">FINANCIAL SUMMARY</div>

      <div class="summary-row">
        <span>Total Cost:</span>
        <span>Rs. ${(summary.total_cost || 0).toFixed(2)}</span>
      </div>
      <div class="summary-row">
        <span>Total Revenue:</span>
        <span>Rs. ${(summary.total_revenue || 0).toFixed(2)}</span>
      </div>
      <div class="summary-row total">
        <span>Net Profit:</span>
        <span>Rs. ${(summary.total_profit || 0).toFixed(2)}</span>
      </div>

      <div class="footer">
        <p>System by ZipZipy PVT LTD</p>
        <p>Contact: 0788915271</p>
      </div>
    </body>
    </html>
  `;

  const { BrowserWindow } = require("@electron/remote");
  const printWindow = new BrowserWindow({ show: false });
  printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(billContent));
  printWindow.webContents.on("did-finish-load", () => {
    printWindow.webContents.print({ silent: true }, (success) => {
      if (!success) console.log("Print failed");
      printWindow.close();
    });
  });
}

// 2. Product-wise Sales Report
document.getElementById("print-product-sales").addEventListener("click", () => {
  const dates = getReportDateRange();
  if (!dates) return;

  printProductSalesReport(dates.fromDate, dates.toDate);
});

function printProductSalesReport(fromDate, toDate) {
  const productsStmt = db.prepare(`
    SELECT
      p.product_code,
      p.product_name,
      SUM(oi.quantity) as total_qty,
      oi.cost_per_unit,
      oi.sale_price_per_unit,
      SUM(oi.total_sale_price) as total_revenue
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE DATE(o.created_at) BETWEEN ? AND ?
    GROUP BY p.product_code, p.product_name, oi.cost_per_unit, oi.sale_price_per_unit
    ORDER BY total_revenue DESC
  `);

  const products = productsStmt.all(fromDate, toDate);

  const now = new Date();
  const printTime = now.toLocaleString("en-GB");

  const totalRevenue = products.reduce((sum, p) => sum + p.total_revenue, 0);

  const billContent = `
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: 72mm auto; margin: 0; }
        body {
          width: 68mm;
          margin: 0;
          padding: 2mm;
          font-family: Arial, sans-serif;
          font-size: 11px;
          line-height: 1.3;
        }
        .header {
          text-align: center;
          margin-bottom: 6px;
        }
        .header h1 {
          font-size: 16px;
          font-weight: bold;
          margin-bottom: 2px;
        }
        .header p {
          font-size: 11px;
          margin: 1px 0;
        }
        .separator {
          border-top: 1px dashed #000;
          margin: 5px 0;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
          margin: 5px 0;
        }
        th {
          text-align: left;
          border-bottom: 1px solid #000;
          padding: 3px 1px;
          font-size: 10px;
          font-weight: bold;
        }
        td {
          padding: 3px 1px;
          border-bottom: 1px dotted #ccc;
          vertical-align: top;
        }
        .text-right {
          text-align: right;
        }
        .text-center {
          text-align: center;
        }
        .total-row {
          font-weight: bold;
          font-size: 11px;
          border-top: 1px solid #000;
          padding-top: 4px;
        }
        .footer {
          text-align: center;
          font-size: 8px;
          margin-top: 8px;
          padding-top: 5px;
          border-top: 1px dashed #000;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>NEPTUNE MOBILE</h1>
        <p>PRODUCT SALES REPORT</p>
        <p>${fromDate === toDate ? fromDate : fromDate + ' to ' + toDate}</p>
        <p style="font-size: 7px;">Printed: ${printTime}</p>
      </div>

      <div class="separator"></div>

      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Product</th>
            <th class="text-center">Qty</th>
            <th class="text-right">Price</th>
            <th class="text-right">Revenue</th>
          </tr>
        </thead>
        <tbody>
          ${products.map(p => `
            <tr>
              <td>${p.product_code}</td>
              <td>${p.product_name}</td>
              <td class="text-center">${p.total_qty}</td>
              <td class="text-right">${p.sale_price_per_unit.toFixed(2)}</td>
              <td class="text-right"><strong>${p.total_revenue.toFixed(2)}</strong></td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr class="total-row">
            <td colspan="4" class="text-right">TOTAL:</td>
            <td class="text-right"><strong>Rs. ${totalRevenue.toFixed(2)}</strong></td>
          </tr>
        </tfoot>
      </table>

      <div class="footer">
        <p>System by ZipZipy PVT LTD | 0788915271</p>
      </div>
    </body>
    </html>
  `;

  const { BrowserWindow } = require("@electron/remote");
  const printWindow = new BrowserWindow({ show: false });
  printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(billContent));
  printWindow.webContents.on("did-finish-load", () => {
    printWindow.webContents.print({ silent: true }, (success) => {
      if (!success) console.log("Print failed");
      printWindow.close();
    });
  });
}

// 3. Profit Analysis Report
document.getElementById("print-profit-analysis").addEventListener("click", () => {
  const dates = getReportDateRange();
  if (!dates) return;

  printProfitAnalysisReport(dates.fromDate, dates.toDate);
});

function printProfitAnalysisReport(fromDate, toDate) {
  const profitStmt = db.prepare(`
    SELECT
      p.product_code,
      p.product_name,
      SUM(oi.quantity) as total_qty,
      oi.cost_per_unit,
      oi.sale_price_per_unit,
      SUM(oi.total_cost) as total_cost,
      SUM(oi.total_sale_price) as total_revenue,
      SUM(oi.total_sale_price - oi.total_cost) as profit,
      ((oi.sale_price_per_unit - oi.cost_per_unit) / oi.cost_per_unit * 100) as profit_margin
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE DATE(o.created_at) BETWEEN ? AND ?
    GROUP BY p.product_code, p.product_name, oi.cost_per_unit, oi.sale_price_per_unit
    ORDER BY profit DESC
  `);

  const products = profitStmt.all(fromDate, toDate);

  const now = new Date();
  const printTime = now.toLocaleString("en-GB");

  const totalCost = products.reduce((sum, p) => sum + p.total_cost, 0);
  const totalRevenue = products.reduce((sum, p) => sum + p.total_revenue, 0);
  const totalProfit = products.reduce((sum, p) => sum + p.profit, 0);

  const billContent = `
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: 72mm auto; margin: 0; }
        body {
          width: 68mm;
          margin: 0;
          padding: 2mm;
          font-family: Arial, sans-serif;
          font-size: 10px;
          line-height: 1.3;
        }
        .header {
          text-align: center;
          margin-bottom: 6px;
        }
        .header h1 {
          font-size: 16px;
          font-weight: bold;
          margin-bottom: 2px;
        }
        .header p {
          font-size: 11px;
          margin: 1px 0;
        }
        .separator {
          border-top: 1px dashed #000;
          margin: 5px 0;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 9px;
          margin: 5px 0;
        }
        th {
          text-align: left;
          border-bottom: 1px solid #000;
          padding: 3px 1px;
          font-size: 9px;
          font-weight: bold;
        }
        td {
          padding: 3px 1px;
          border-bottom: 1px dotted #ccc;
          vertical-align: top;
        }
        .text-right {
          text-align: right;
        }
        .text-center {
          text-align: center;
        }
        .total-row {
          font-weight: bold;
          font-size: 10px;
          border-top: 1px solid #000;
        }
        .footer {
          text-align: center;
          font-size: 8px;
          margin-top: 8px;
          padding-top: 5px;
          border-top: 1px dashed #000;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>NEPTUNE MOBILE</h1>
        <p>PROFIT ANALYSIS</p>
        <p>${fromDate === toDate ? fromDate : fromDate + ' to ' + toDate}</p>
        <p style="font-size: 9px;">Printed: ${printTime}</p>
      </div>

      <div class="separator"></div>

      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th class="text-center">Qty</th>
            <th class="text-right">Cost</th>
            <th class="text-right">Rev</th>
            <th class="text-right">Profit</th>
          </tr>
        </thead>
        <tbody>
          ${products.map(p => `
            <tr>
              <td style="font-size: 9px;"><strong>${p.product_code}</strong><br>${p.product_name}</td>
              <td class="text-center">${p.total_qty}</td>
              <td class="text-right">${p.total_cost.toFixed(2)}</td>
              <td class="text-right">${p.total_revenue.toFixed(2)}</td>
              <td class="text-right"><strong>${p.profit.toFixed(2)}</strong><br><small>${p.profit_margin.toFixed(1)}%</small></td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr class="total-row">
            <td colspan="2" class="text-right">TOTAL:</td>
            <td class="text-right">${totalCost.toFixed(2)}</td>
            <td class="text-right">${totalRevenue.toFixed(2)}</td>
            <td class="text-right"><strong>${totalProfit.toFixed(2)}</strong></td>
          </tr>
        </tfoot>
      </table>

      <div class="footer">
        <p>System by ZipZipy PVT LTD | 0788915271</p>
      </div>
    </body>
    </html>
  `;

  const { BrowserWindow } = require("@electron/remote");
  const printWindow = new BrowserWindow({ show: false });
  printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(billContent));
  printWindow.webContents.on("did-finish-load", () => {
    printWindow.webContents.print({ silent: true }, (success) => {
      if (!success) console.log("Print failed");
      printWindow.close();
    });
  });
}

// 4. Returns Summary Report
document.getElementById("print-returns-summary").addEventListener("click", () => {
  const dates = getReportDateRange();
  if (!dates) return;

  printReturnsSummaryReport(dates.fromDate, dates.toDate);
});

function printReturnsSummaryReport(fromDate, toDate) {
  const returnsStmt = db.prepare(`
    SELECT
      p.product_code,
      p.product_name,
      ABS(oi.quantity) as return_qty,
      oi.sale_price_per_unit,
      ABS(oi.total_sale_price) as refund_amount,
      o.created_at
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE DATE(o.created_at) BETWEEN ? AND ?
      AND oi.quantity < 0
    ORDER BY o.created_at DESC
  `);

  const returns = returnsStmt.all(fromDate, toDate);

  const now = new Date();
  const printTime = now.toLocaleString("en-GB");

  const totalRefund = returns.reduce((sum, r) => sum + r.refund_amount, 0);
  const totalItems = returns.reduce((sum, r) => sum + r.return_qty, 0);

  const billContent = `
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: 72mm auto; margin: 0; }
        body {
          width: 68mm;
          margin: 0;
          padding: 2mm;
          font-family: Arial, sans-serif;
          font-size: 10px;
          line-height: 1.3;
        }
        .header {
          text-align: center;
          margin-bottom: 6px;
        }
        .header h1 {
          font-size: 16px;
          font-weight: bold;
          margin-bottom: 2px;
        }
        .header p {
          font-size: 11px;
          margin: 1px 0;
        }
        .separator {
          border-top: 1px dashed #000;
          margin: 5px 0;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
          margin: 5px 0;
        }
        th {
          text-align: left;
          border-bottom: 1px solid #000;
          padding: 3px 1px;
          font-size: 10px;
          font-weight: bold;
        }
        td {
          padding: 3px 1px;
          border-bottom: 1px dotted #ccc;
          vertical-align: top;
          background-color: #ffe6e6;
        }
        .text-right {
          text-align: right;
        }
        .text-center {
          text-align: center;
        }
        .summary-section {
          margin-top: 8px;
          padding-top: 6px;
          border-top: 1px solid #000;
          font-size: 10px;
        }
        .summary-row {
          display: flex;
          justify-content: space-between;
          margin: 3px 0;
          font-weight: bold;
        }
        .footer {
          text-align: center;
          font-size: 8px;
          margin-top: 8px;
          padding-top: 5px;
          border-top: 1px dashed #000;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>NEPTUNE MOBILE</h1>
        <p>RETURNS SUMMARY</p>
        <p>${fromDate === toDate ? fromDate : fromDate + ' to ' + toDate}</p>
        <p style="font-size: 9px;">Printed: ${printTime}</p>
      </div>

      <div class="separator"></div>

      ${returns.length === 0 ? '<p style="text-align: center; color: #666; font-size: 11px;">No returns in this period</p>' : `
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th class="text-center">Qty</th>
            <th class="text-right">Price</th>
            <th class="text-right">Refund</th>
          </tr>
        </thead>
        <tbody>
          ${returns.map(r => {
            const returnDate = new Date(r.created_at).toLocaleDateString("en-GB");
            return `
            <tr>
              <td style="font-size: 9px;"><strong>${r.product_code}</strong><br>${r.product_name}<br><small>${returnDate}</small></td>
              <td class="text-center">${r.return_qty}</td>
              <td class="text-right">${r.sale_price_per_unit.toFixed(2)}</td>
              <td class="text-right"><strong>${r.refund_amount.toFixed(2)}</strong></td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
      `}

      <div class="summary-section">
        <div class="summary-row">
          <span>Total Returns:</span>
          <span>${returns.length}</span>
        </div>
        <div class="summary-row">
          <span>Total Items:</span>
          <span>${totalItems}</span>
        </div>
        <div class="summary-row" style="font-size: 10px; margin-top: 5px; padding-top: 5px; border-top: 1px solid #000;">
          <span>Total Refund:</span>
          <span>Rs. ${totalRefund.toFixed(2)}</span>
        </div>
      </div>

      <div class="footer">
        <p>System by ZipZipy PVT LTD | 0788915271</p>
      </div>
    </body>
    </html>
  `;

  const { BrowserWindow } = require("@electron/remote");
  const printWindow = new BrowserWindow({ show: false });
  printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(billContent));
  printWindow.webContents.on("did-finish-load", () => {
    printWindow.webContents.print({ silent: true }, (success) => {
      if (!success) console.log("Print failed");
      printWindow.close();
    });
  });
}

// 5. Detailed Report - All transactions
document.getElementById("print-detailed-report").addEventListener("click", () => {
  const dates = getReportDateRange();
  if (!dates) return;

  printDetailedReport(dates.fromDate, dates.toDate);
});

function printDetailedReport(fromDate, toDate) {
  const detailsStmt = db.prepare(`
    SELECT
      p.product_code,
      p.product_name,
      oi.quantity,
      oi.cost_per_unit,
      oi.sale_price_per_unit,
      oi.total_cost,
      oi.total_sale_price,
      (oi.total_sale_price - oi.total_cost) as profit,
      o.created_at,
      o.id as order_id
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE DATE(o.created_at) BETWEEN ? AND ?
    ORDER BY o.created_at ASC, oi.id ASC
  `);

  const items = detailsStmt.all(fromDate, toDate);

  const now = new Date();
  const printTime = now.toLocaleString("en-GB");

  const totalCost = items.reduce((sum, i) => sum + i.total_cost, 0);
  const totalRevenue = items.reduce((sum, i) => sum + i.total_sale_price, 0);
  const totalProfit = items.reduce((sum, i) => sum + i.profit, 0);

  const billContent = `
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: 72mm auto; margin: 0; }
        body {
          width: 68mm;
          margin: 0;
          padding: 2mm;
          font-family: Arial, sans-serif;
          font-size: 10px;
          line-height: 1.2;
        }
        .header {
          text-align: center;
          margin-bottom: 6px;
        }
        .header h1 {
          font-size: 15px;
          font-weight: bold;
          margin-bottom: 2px;
        }
        .header p {
          font-size: 10px;
          margin: 1px 0;
        }
        .separator {
          border-top: 1px dashed #000;
          margin: 5px 0;
        }
        .item {
          margin: 4px 0;
          padding: 3px;
          border-bottom: 1px dotted #ccc;
          font-size: 10px;
        }
        .item.return {
          background-color: #ffe6e6;
          border-left: 2px solid #ff6b6b;
        }
        .item-header {
          font-weight: bold;
          font-size: 10px;
        }
        .item-row {
          display: flex;
          justify-content: space-between;
          margin: 1px 0;
        }
        .total-section {
          margin-top: 6px;
          padding-top: 5px;
          border-top: 1px solid #000;
          font-size: 11px;
        }
        .total-row {
          display: flex;
          justify-content: space-between;
          margin: 2px 0;
          font-weight: bold;
        }
        .footer {
          text-align: center;
          font-size: 8px;
          margin-top: 8px;
          padding-top: 5px;
          border-top: 1px dashed #000;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>NEPTUNE MOBILE</h1>
        <p>DETAILED SALES REPORT</p>
        <p>${fromDate === toDate ? fromDate : fromDate + ' to ' + toDate}</p>
        <p style="font-size: 8px;">Printed: ${printTime}</p>
      </div>

      <div class="separator"></div>

      ${items.map(item => {
        const isReturn = item.quantity < 0;
        const itemClass = isReturn ? 'item return' : 'item';
        const itemDate = new Date(item.created_at).toLocaleDateString("en-GB");
        const itemTime = new Date(item.created_at).toLocaleTimeString("en-GB", { hour: '2-digit', minute: '2-digit' });

        return `
        <div class="${itemClass}">
          <div class="item-header">${item.product_code} - ${item.product_name} ${isReturn ? '(RETURN)' : ''}</div>
          <div class="item-row">
            <span>Order #${item.order_id}</span>
            <span>${itemDate} ${itemTime}</span>
          </div>
          <div class="item-row">
            <span>Qty: ${item.quantity}</span>
            <span>@ Rs. ${item.sale_price_per_unit.toFixed(2)}</span>
          </div>
          <div class="item-row">
            <span>Cost: Rs. ${item.total_cost.toFixed(2)}</span>
            <span>Revenue: Rs. ${item.total_sale_price.toFixed(2)}</span>
          </div>
          <div class="item-row">
            <span>Profit:</span>
            <span><strong>Rs. ${item.profit.toFixed(2)}</strong></span>
          </div>
        </div>
      `}).join('')}

      <div class="total-section">
        <div class="total-row">
          <span>Total Transactions:</span>
          <span>${items.length}</span>
        </div>
        <div class="total-row">
          <span>Total Cost:</span>
          <span>Rs. ${totalCost.toFixed(2)}</span>
        </div>
        <div class="total-row">
          <span>Total Revenue:</span>
          <span>Rs. ${totalRevenue.toFixed(2)}</span>
        </div>
        <div class="total-row" style="font-size: 12px; margin-top: 4px; padding-top: 4px; border-top: 1px solid #000;">
          <span>NET PROFIT:</span>
          <span>Rs. ${totalProfit.toFixed(2)}</span>
        </div>
      </div>

      <div class="footer">
        <p>System by ZipZipy PVT LTD | 0788915271</p>
      </div>
    </body>
    </html>
  `;

  const { BrowserWindow } = require("@electron/remote");
  const printWindow = new BrowserWindow({ show: false });
  printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(billContent));
  printWindow.webContents.on("did-finish-load", () => {
    printWindow.webContents.print({ silent: true }, (success) => {
      if (!success) console.log("Print failed");
      printWindow.close();
    });
  });
}

let orderSearchQuery = "";

function loadOrderHistory() {
  let query = `
    SELECT
      o.id,
      o.created_at,
      o.total_cost,
      o.total_sale_price,
      o.profit,
      COUNT(oi.id) as item_count,
      MIN(oi.quantity) as min_qty
    FROM orders o
    LEFT JOIN order_items oi ON o.id = oi.order_id
  `;

  let params = [];
  if (orderSearchQuery) {
    query += " WHERE CAST(o.id AS TEXT) LIKE ?";
    params = [`%${orderSearchQuery}%`];
  }

  query += `
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `;

  const orderStmt = db.prepare(query);
  const orders = params.length > 0 ? orderStmt.all(...params) : orderStmt.all();

  const tbody = document.getElementById("order-history-items");

  if (orders.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" style="text-align: center; color: #999;">No orders found</td></tr>';
    return;
  }

  tbody.innerHTML = orders
    .map((order) => {
      const orderDate = new Date(order.created_at);
      const formattedDate = orderDate.toLocaleDateString("en-GB");
      const formattedTime = orderDate.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      // Check if any item has negative quantity (return)
      const isReturn = order.min_qty < 0;
      const rowStyle = isReturn ? 'style="background-color: #fff3cd;"' : '';
      const returnBadge = isReturn
        ? '<span style="color: #f59e0b; font-weight: bold;">[RETURN]</span>'
        : "";

      return `
      <tr ${rowStyle}>
        <td>${order.id} ${returnBadge}</td>
        <td>${formattedDate}</td>
        <td>${formattedTime}</td>
        <td>Rs. ${order.total_sale_price.toFixed(2)}</td>
        <td>Rs. ${order.total_cost.toFixed(2)}</td>
        <td>Rs. ${order.profit.toFixed(2)}</td>
        <td>${order.item_count}</td>
        <td>
          <button class="btn btn-primary" onclick="viewOrderDetails(${
            order.id
          })">View</button>
        </td>
      </tr>
    `;
    })
    .join("");
}

document.getElementById("order-search-input").addEventListener("input", (e) => {
  orderSearchQuery = e.target.value.trim();
  loadOrderHistory();
});

function viewOrderDetails(orderId) {
  const orderStmt = db.prepare("SELECT * FROM orders WHERE id = ?");
  const order = orderStmt.get(orderId);

  const itemsStmt = db.prepare(`
    SELECT
      oi.*,
      p.product_code,
      p.product_name
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `);
  const items = itemsStmt.all(orderId);

  const orderDate = new Date(order.created_at);
  const formattedDate = orderDate.toLocaleDateString("en-GB");
  const formattedTime = orderDate.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Check if any item has negative quantity (return)
  const hasNegativeQty = items.some((item) => item.quantity < 0);
  const returnBadge = hasNegativeQty ? ' [RETURN]' : '';

  document.getElementById("order-detail-id").textContent = order.id + returnBadge;
  document.getElementById("order-detail-date").textContent = formattedDate;
  document.getElementById("order-detail-time").textContent = formattedTime;

  if (order.customer_name) {
    document.getElementById("order-customer-row").style.display = "flex";
    document.getElementById("order-detail-customer").textContent =
      order.customer_name;
  } else {
    document.getElementById("order-customer-row").style.display = "none";
  }

  if (order.customer_mobile) {
    document.getElementById("order-mobile-row").style.display = "flex";
    document.getElementById("order-detail-mobile").textContent =
      order.customer_mobile;
  } else {
    document.getElementById("order-mobile-row").style.display = "none";
  }

  const itemsTableBody = document.getElementById("order-detail-items");
  itemsTableBody.innerHTML = items
    .map(
      (item) => {
        const isReturnItem = item.quantity < 0;
        const rowStyle = isReturnItem ? 'style="background-color: #fff3cd;"' : '';
        const qtyLabel = isReturnItem ? `${item.quantity} (RETURN)` : item.quantity;

        return `
    <tr ${rowStyle}>
      <td>${item.product_code}</td>
      <td>${item.product_name}</td>
      <td>${qtyLabel}</td>
      <td>Rs. ${item.cost_per_unit.toFixed(2)}</td>
      <td>Rs. ${item.sale_price_per_unit.toFixed(2)}</td>
      <td>Rs. ${item.total_sale_price.toFixed(2)}</td>
    </tr>
  `;
      }
    )
    .join("");

  document.getElementById(
    "order-detail-total-cost"
  ).textContent = `Rs. ${order.total_cost.toFixed(2)}`;
  document.getElementById(
    "order-detail-total-sale"
  ).textContent = `Rs. ${order.total_sale_price.toFixed(2)}`;
  document.getElementById(
    "order-detail-profit"
  ).textContent = `Rs. ${order.profit.toFixed(2)}`;

  const modal = document.getElementById("order-details-modal");
  modal.style.display = "flex";
}

document
  .getElementById("order-details-close-btn")
  .addEventListener("click", () => {
    document.getElementById("order-details-modal").style.display = "none";
  });

function loadCustomers(searchQuery = "") {
  let customersStmt;
  let customers;

  if (searchQuery.trim() === "") {
    // Load all customers
    customersStmt = db.prepare(`
      SELECT
        c.id,
        c.name,
        c.mobile,
        COUNT(DISTINCT o.id) as total_orders,
        MAX(o.created_at) as last_order
      FROM customers c
      LEFT JOIN orders o ON (c.mobile = o.customer_mobile AND c.mobile IS NOT NULL AND o.customer_mobile IS NOT NULL)
      GROUP BY c.id, c.name, c.mobile
      ORDER BY c.id DESC
    `);
    customers = customersStmt.all();
  } else {
    // Search by name or mobile
    customersStmt = db.prepare(`
      SELECT
        c.id,
        c.name,
        c.mobile,
        COUNT(DISTINCT o.id) as total_orders,
        MAX(o.created_at) as last_order
      FROM customers c
      LEFT JOIN orders o ON (c.mobile = o.customer_mobile AND c.mobile IS NOT NULL AND o.customer_mobile IS NOT NULL)
      WHERE c.name LIKE ? OR c.mobile LIKE ?
      GROUP BY c.id, c.name, c.mobile
      ORDER BY c.id DESC
    `);
    const searchPattern = `%${searchQuery}%`;
    customers = customersStmt.all(searchPattern, searchPattern);
  }

  const tbody = document.getElementById("customers-items");

  if (customers.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" style="text-align: center; color: #999;">No customers found</td></tr>';
    return;
  }

  tbody.innerHTML = customers
    .map((customer) => {
      const lastOrderDate = customer.last_order
        ? new Date(customer.last_order).toLocaleDateString("en-GB")
        : "N/A";

      return `
      <tr>
        <td>${customer.id}</td>
        <td>${customer.name}</td>
        <td>${customer.mobile || "N/A"}</td>
        <td>${customer.total_orders}</td>
        <td>${lastOrderDate}</td>
      </tr>
    `;
    })
    .join("");
}

// Customer search event listener
document.getElementById("customer-search-input").addEventListener("input", (e) => {
  const searchQuery = e.target.value;
  loadCustomers(searchQuery);
});

function updateUIBasedOnAuth() {
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const userRoleDisplay = document.getElementById("user-role-display");

  const inventoryTab = document.getElementById("nav-inventory");
  const analyticsTab = document.getElementById("nav-analytics");
  const orderHistoryTab = document.getElementById("nav-order-history");
  const customersTab = document.getElementById("nav-customers");
  const reportsTab = document.getElementById("nav-reports");
  const settingsTab = document.getElementById("nav-settings");

  if (isLoggedIn) {
    loginBtn.style.display = "none";
    logoutBtn.style.display = "inline-block";
    userRoleDisplay.style.display = "inline-block";

    // Set role display text
    const roleNames = {
      'cashier': '👤 Cashier',
      'grn': '📦 GRN Staff (Savindu)',
      'admin': '🔑 Admin'
    };
    userRoleDisplay.textContent = roleNames[currentUserRole] || '';

    // Show/hide tabs based on role
    if (currentUserRole === "cashier") {
      // Cashier: Only Sales
      inventoryTab.style.display = "none";
      analyticsTab.style.display = "none";
      orderHistoryTab.style.display = "none";
      customersTab.style.display = "none";
      reportsTab.style.display = "none";
      settingsTab.style.display = "none";
    } else if (currentUserRole === "grn") {
      // GRN Staff: Sales + GRN
      inventoryTab.style.display = "inline-block";
      analyticsTab.style.display = "none";
      orderHistoryTab.style.display = "none";
      customersTab.style.display = "none";
      reportsTab.style.display = "none";
      settingsTab.style.display = "none";
    } else if (currentUserRole === "admin") {
      // Admin: All sections
      inventoryTab.style.display = "inline-block";
      analyticsTab.style.display = "inline-block";
      orderHistoryTab.style.display = "inline-block";
      customersTab.style.display = "inline-block";
      reportsTab.style.display = "inline-block";
      settingsTab.style.display = "inline-block";
    }

    updateResetButtonVisibility();
  } else {
    // Not logged in - hide all except login button
    inventoryTab.style.display = "none";
    analyticsTab.style.display = "none";
    orderHistoryTab.style.display = "none";
    customersTab.style.display = "none";
    reportsTab.style.display = "none";
    settingsTab.style.display = "none";

    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
    userRoleDisplay.style.display = "none";

    updateResetButtonVisibility();

    const currentSection = document.querySelector(".section.active");
    if (currentSection && currentSection.id !== "pos-section") {
      switchSection("pos");
    }
  }
}

function updateResetButtonVisibility() {
  const resetBtn = document.getElementById("reset-btn");
  const currentSection = document.querySelector(".section.active");

  if (currentSection && currentSection.id === "pos-section") {
    resetBtn.style.display = "inline-block";
  } else {
    resetBtn.style.display = "none";
  }
}

function showLoginModal() {
  const modal = document.getElementById("login-modal");
  modal.style.display = "flex";

  document.getElementById("login-username").value = "";
  document.getElementById("login-password").value = "";

  setTimeout(() => {
    document.getElementById("login-username").focus();
  }, 100);
}

document.getElementById("login-btn").addEventListener("click", () => {
  showLoginModal();
});

document.getElementById("login-username").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("login-password").focus();
  }
});

document.getElementById("login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    attemptLogin();
  }
});

document.getElementById("login-submit-btn").addEventListener("click", (e) => {
  e.preventDefault();
  attemptLogin();
});

document.getElementById("login-cancel-btn").addEventListener("click", () => {
  document.getElementById("login-modal").style.display = "none";
});

function attemptLogin() {
  const username = document.getElementById("login-username").value.trim().toLowerCase();
  const password = document.getElementById("login-password").value;

  // Cashier login - no password required
  if (username === CASHIER_USERNAME.toLowerCase()) {
    currentUserRole = "cashier";
    isLoggedIn = true;
    document.getElementById("login-modal").style.display = "none";

    showSuccessModal("Login successful! Welcome Cashier.", () => {
      updateUIBasedOnAuth();
    });
    return;
  }

  // Require password for other roles
  if (!password) {
    showErrorModal("Please enter password!");
    return;
  }

  // Admin login
  if (username === ADMIN_USERNAME.toLowerCase() && password === ADMIN_PASSWORD) {
    currentUserRole = "admin";
    isLoggedIn = true;
    document.getElementById("login-modal").style.display = "none";

    showSuccessModal("Login successful! Welcome Admin.", () => {
      updateUIBasedOnAuth();
    });
    return;
  }

  // GRN staff login
  const grnPassword = getGRNPassword();
  if (username === GRN_USERNAME.toLowerCase() && password === grnPassword) {
    currentUserRole = "grn";
    isLoggedIn = true;
    document.getElementById("login-modal").style.display = "none";

    showSuccessModal("Login successful! Welcome GRN Staff.", () => {
      updateUIBasedOnAuth();
    });
    return;
  }

  // Invalid credentials
  showErrorModal("Invalid username or password!", () => {
    document.getElementById("login-password").value = "";
    setTimeout(() => {
      document.getElementById("login-password").focus();
    }, 100);
  });
}

document.getElementById("logout-btn").addEventListener("click", () => {
  showLogoutConfirmation();
});

function showLogoutConfirmation() {
  const modal = document.getElementById("logout-confirm-modal");
  const yesBtn = document.getElementById("logout-confirm-yes-btn");
  const noBtn = document.getElementById("logout-confirm-no-btn");

  modal.style.display = "flex";

  const handleYes = () => {
    modal.style.display = "none";
    yesBtn.removeEventListener("click", handleYes);
    noBtn.removeEventListener("click", handleNo);
    document.removeEventListener("keydown", handleKeyPress);
    performLogout();
  };

  const handleNo = () => {
    modal.style.display = "none";
    yesBtn.removeEventListener("click", handleYes);
    noBtn.removeEventListener("click", handleNo);
    document.removeEventListener("keydown", handleKeyPress);
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleYes();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleNo();
    }
  };

  yesBtn.addEventListener("click", (e) => {
    e.target.blur();
    handleYes();
  });

  noBtn.addEventListener("click", (e) => {
    e.target.blur();
    handleNo();
  });

  document.addEventListener("keydown", handleKeyPress);

  setTimeout(() => yesBtn.focus(), 100);
}

function performLogout() {
  currentUserRole = null;
  isLoggedIn = false;
  updateUIBasedOnAuth();
  showSuccessModal("Logged out successfully!");
}

document.getElementById("reset-btn").addEventListener("click", () => {
  cart = [];
  selectedProduct = null;
  currentSearchResultIndex = -1;

  document.getElementById("product-code-input").value = "";
  document.getElementById("paid-amount-input").value = "";
  document.getElementById("customer-name-input").value = "";
  document.getElementById("customer-mobile-input").value = "";

  document.getElementById("search-results-body").innerHTML = "";

  updateCart();

  document.getElementById("balance-display").style.display = "none";

  hideSelectedProductDetails();

  focusProductCodeInput();
});

document.getElementById("close-app-btn").addEventListener("click", () => {
  showConfirmModal(
    "Close Application",
    "Are you sure you want to close the application? A backup will be created automatically.",
    () => {
      ipcRenderer.send("close-app");
    },
    null
  );
});

// Settings - Update GRN Password
document.getElementById("update-grn-password-btn").addEventListener("click", () => {
  if (currentUserRole !== "admin") {
    showErrorModal("Only admin can change GRN password!");
    return;
  }

  const currentPassword = document.getElementById("current-grn-password").value.trim();
  const newPassword = document.getElementById("new-grn-password").value.trim();
  const confirmPassword = document.getElementById("confirm-grn-password").value.trim();

  if (!currentPassword || !newPassword || !confirmPassword) {
    showErrorModal("Please fill in all password fields!");
    return;
  }

  const actualCurrentPassword = getGRNPassword();
  if (currentPassword !== actualCurrentPassword) {
    showErrorModal("Current GRN password is incorrect!");
    return;
  }

  if (newPassword.length < 6) {
    showErrorModal("New password must be at least 6 characters long!");
    return;
  }

  if (newPassword !== confirmPassword) {
    showErrorModal("New password and confirmation do not match!");
    return;
  }

  try {
    // Ensure settings table exists
    initializeSettingsTable();

    const updateStmt = db.prepare(`
      UPDATE settings
      SET setting_value = ?, updated_at = CURRENT_TIMESTAMP
      WHERE setting_key = 'grn_password'
    `);
    updateStmt.run(newPassword);

    // Clear the form
    document.getElementById("current-grn-password").value = "";
    document.getElementById("new-grn-password").value = "";
    document.getElementById("confirm-grn-password").value = "";

    showSuccessModal("GRN password updated successfully!");
  } catch (error) {
    showErrorModal("Error updating password: " + error.message);
  }
});
