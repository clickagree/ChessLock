const { app, BrowserWindow, globalShortcut, Menu, powerSaveBlocker, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { autoUpdater } = require('electron-updater');

// Auto-updater configuration
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Try to fix crashes with GPU flags
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

// Disable the default menu
Menu.setApplicationMenu(null);

// TESTING MODE - set to true to use buddyboardgames.com instead of chess.com
const TESTING_MODE = false;
const GAME_URL = TESTING_MODE ? 'https://buddyboardgames.com/' : 'https://www.chess.com';

// Check if Zoom is running, using camera, and screen sharing (macOS)
async function checkZoomCamera() {
  try {
    // Check if Zoom is running
    const { stdout: psOutput } = await execAsync('pgrep -x zoom.us || pgrep -f "zoom.us" || echo ""');
    const zoomRunning = psOutput.trim().length > 0;
    
    if (!zoomRunning) {
      return { zoomRunning: false, cameraInUse: false, screenSharing: false };
    }
    
    // Check if camera is actively streaming using IORegistry
    let cameraInUse = false;
    try {
      const { stdout: ioregOutput } = await execAsync(
        'ioreg -l | grep -E "CameraStreaming|CameraActive" | grep -i "Yes" || echo ""'
      );
      cameraInUse = ioregOutput.trim().length > 0;
    } catch {
      cameraInUse = false;
    }
    
    // Check if Zoom is screen sharing
    // Look for Zoom's screen sharing helper process or window server usage
    let screenSharing = false;
    try {
      // Check for CaptureKit/screen capture activity or Zoom sharing process
      const { stdout: shareOutput } = await execAsync(
        'pgrep -f "zoomshare\|CptHost" || echo ""'
      );
      if (shareOutput.trim().length > 0) {
        screenSharing = true;
      } else {
        // Alternative: check if Zoom has screen recording permission active
        const { stdout: lsofOutput } = await execAsync(
          'lsof -c zoom.us 2>/dev/null | grep -i "windowserver\|skylight" || echo ""'
        );
        screenSharing = lsofOutput.trim().length > 0;
      }
    } catch {
      screenSharing = false;
    }
    
    return { zoomRunning: true, cameraInUse, screenSharing };
  } catch (err) {
    return { zoomRunning: false, cameraInUse: false, screenSharing: false };
  }
}

let mainWindow;
let warningWindow = null;
let allowQuit = true;
let monitoringInterval = null;
let updateStatus = { status: 'checking', version: null, error: null };
let resolveCheckInterval = null;
let isShowingWarning = false;
let sessionTerminated = false;
let proctorStarted = false;

// Block system sleep/screen saver
let powerSaveId = null;

// Check if Bluetooth is enabled (macOS)
async function checkBluetooth() {
  try {
    // Use system_profiler to check Bluetooth state
    // Different macOS versions use different formats:
    // - Older: "Bluetooth Power: On"
    // - Newer: "State: On" under Bluetooth Controller
    const { stdout } = await execAsync(
      'system_profiler SPBluetoothDataType 2>/dev/null | grep -iE "(State|Bluetooth Power):" | head -1'
    );
    const isOn = stdout.toLowerCase().includes(': on');
    return { bluetoothEnabled: isOn };
  } catch (err) {
    // If we can't check, assume it's off (fail-safe)
    return { bluetoothEnabled: false };
  }
}

// Get USB device count (excluding built-in devices)
async function getUsbDeviceCount() {
  try {
    // Get USB data and look for actual external devices
    // We look for devices that have a serial number or vendor ID (external devices typically have these)
    // and exclude common internal devices
    const { stdout } = await execAsync(
      `system_profiler SPUSBDataType 2>/dev/null`
    );
    
    // If no USB data at all, return 0
    if (!stdout || stdout.trim() === '' || stdout.includes('No USB')) {
      return 0;
    }
    
    // Split into device blocks and count external ones
    const lines = stdout.split('\n');
    let externalDeviceCount = 0;
    let currentDevice = '';
    let isExternalDevice = false;
    
    for (const line of lines) {
      // Device name lines start with 4 spaces then a letter (not more spaces)
      if (/^    [A-Za-z]/.test(line) && !/^      /.test(line)) {
        // Save previous device if it was external
        if (isExternalDevice) {
          externalDeviceCount++;
        }
        
        currentDevice = line.trim().toLowerCase();
        
        // Skip known internal/built-in devices
        const internalPatterns = [
          'hub', 'internal', 'built-in', 'bluetooth', 'apple', 
          'host controller', 'root hub', 'usb bus', 'usb 3', 'usb 2', 'usb3', 'usb2',
          'bus', 'touch bar', 'ambient light sensor', 'facetime', 'headset', 
          'card reader', 'trackpad', 'keyboard', 'ibridge', 'sensor', 'controller'
        ];
        
        isExternalDevice = !internalPatterns.some(pattern => 
          currentDevice.includes(pattern)
        );
      }
    }
    
    // Check last device
    if (isExternalDevice) {
      externalDeviceCount++;
    }
    
    return externalDeviceCount;
  } catch (err) {
    return 0;
  }
}

// Check if any USB devices are connected
async function checkUsbDevices() {
  const count = await getUsbDeviceCount();
  return { 
    hasUsbDevices: count > 0,
    count
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: false,
    autoHideMenuBar: true,
    frame: true,
    minimizable: false,
    maximizable: false,
    movable: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  // Load start screen first
  mainWindow.loadFile('start.html');

  // Debug crashes
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.log('Render process gone:', details.reason, details.exitCode);
  });

  // Handle did-fail-load to debug
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.log('Failed to load:', validatedURL, errorCode, errorDescription);
  });

  // Prevent window from being closed
  mainWindow.on('close', (e) => {
    if (!allowQuit) {
      e.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent minimize/hide
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.restore();
  });

  mainWindow.on('hide', (e) => {
    e.preventDefault();
    mainWindow.show();
  });

  // Keep window focused
  mainWindow.on('blur', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.setAlwaysOnTop(true);
      }
    }, 100);
  });

  // Handle new windows - load game URLs in same window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('chess.com') || url.includes('buddyboardgames.com')) {
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Handle Zoom camera check
  ipcMain.handle('check-zoom-camera', async () => {
    return await checkZoomCamera();
  });

  // Handle display check - returns number of displays
  ipcMain.handle('check-displays', () => {
    const displays = screen.getAllDisplays();
    return { count: displays.length };
  });

  // Handle Bluetooth check
  ipcMain.handle('check-bluetooth', async () => {
    return await checkBluetooth();
  });

  // Handle USB device check
  ipcMain.handle('check-usb', async () => {
    return await checkUsbDevices();
  });

  // Handle app version request
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Handle update status request
  ipcMain.handle('get-update-status', () => {
    return updateStatus;
  });

  // Handle start proctor button
  ipcMain.on('start-proctor', async () => {
    if (!proctorStarted) {
      proctorStarted = true;
      
      console.log('Starting proctor mode...');
      
      // Lock down window
      mainWindow.setClosable(false);
      mainWindow.setMinimizable(false);
      mainWindow.setMaximizable(false);
      mainWindow.setMovable(false);
      mainWindow.setResizable(false);
      
      // Set fullscreen first, then kiosk
      mainWindow.setSimpleFullScreen(true);
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      
      // Set kiosk after a brief delay to ensure it takes effect
      setTimeout(() => {
        mainWindow.setKiosk(false);
        mainWindow.setClosable(false);
        console.log('Kiosk:', mainWindow.isKiosk());
        
        // Start active monitoring
        startActiveMonitoring();
        
      }, 100);
      
      console.log('Fullscreen:', mainWindow.isSimpleFullScreen());
      
      // Load game site
      mainWindow.loadURL(GAME_URL);
    }
  });

  // Handle warning timer expired
  ipcMain.on('warning-timer-expired', async () => {
    console.log('Warning timer expired, checking status...');
    
    // Recheck the issues
    const displayResult = screen.getAllDisplays();
    const zoomResult = await checkZoomCamera();
    const bluetoothResult = await checkBluetooth();
    const usbResult = await checkUsbDevices();
    
    const hasDisplayIssue = displayResult.length > 1;
    const hasCameraIssue = !zoomResult.zoomRunning || !zoomResult.cameraInUse;
    const hasBluetoothIssue = bluetoothResult.bluetoothEnabled;
    const hasUsbIssue = usbResult.hasUsbDevices;
    
    if (hasDisplayIssue || hasCameraIssue || hasBluetoothIssue || hasUsbIssue) {
      // Issue still present - terminate session
      terminateChessSession();
    } else {
      // Issue resolved - close warning and resume
      closeWarningWindow();
    }
  });

  // Handle terminate proctor button (from terminated.html)
  ipcMain.on('terminate-proctor', () => {
    console.log('Terminating proctor app...');
    allowQuit = true;
    app.quit();
  });

  // Handle end proctor button (graceful exit during session)
  ipcMain.on('end-proctor', () => {
    console.log('End proctor requested...');
    
    // Stop monitoring
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }
    
    // Close warning window if open
    if (warningWindow && !warningWindow.isDestroyed()) {
      warningWindow.close();
      warningWindow = null;
    }
    
    // Exit fullscreen/kiosk mode before quitting
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setKiosk(false);
      mainWindow.setSimpleFullScreen(false);
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setFullScreen(false);
      mainWindow.setClosable(true);
    }
    
    // Small delay to let fullscreen exit complete
    setTimeout(() => {
      allowQuit = true;
      app.quit();
    }, 200);
  });

  // Navigation restriction (disabled for testing)
  // mainWindow.webContents.on('will-navigate', (event, url) => {
    // if (!url.includes('chess.com') && !url.includes('start.html')) {
   //  event.preventDefault();
   // }
 // });

  // Debug: log all navigation
  mainWindow.webContents.on('will-navigate', (event, url) => {
    console.log('Navigating to:', url);
  });
  
  mainWindow.webContents.on('did-navigate', (event, url) => {
    console.log('Navigated to:', url);
  });

  mainWindow.webContents.on('did-navigate-in-page', (event, url) => {
    console.log('In-page navigation:', url);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.log('Render process gone:', details.reason);
  });

}

// Active monitoring functions
function startActiveMonitoring() {
  console.log('Starting active monitoring...');
  
  monitoringInterval = setInterval(async () => {
    if (sessionTerminated || isShowingWarning) return;
    
    // Check for issues
    const displayResult = screen.getAllDisplays();
    const zoomResult = await checkZoomCamera();
    const bluetoothResult = await checkBluetooth();
    const usbResult = await checkUsbDevices();
    
    const hasDisplayIssue = displayResult.length > 1;
    const hasCameraIssue = !zoomResult.zoomRunning || !zoomResult.cameraInUse;
    const hasBluetoothIssue = bluetoothResult.bluetoothEnabled;
    const hasUsbIssue = usbResult.hasUsbDevices;
    
    if (hasDisplayIssue || hasCameraIssue || hasBluetoothIssue || hasUsbIssue) {
      let issueMessage = '';
      if (hasDisplayIssue) {
        issueMessage = 'External display detected';
      } else if (!zoomResult.zoomRunning) {
        issueMessage = 'Zoom is not running';
      } else if (!zoomResult.cameraInUse) {
        issueMessage = 'Camera has been turned off';
      } else if (hasBluetoothIssue) {
        issueMessage = 'Bluetooth must be disabled';
      } else if (hasUsbIssue) {
        issueMessage = 'Disconnect all USB devices';
      }
      
      console.log('Issue detected:', issueMessage);
      showWarningWindow(issueMessage);
    }
  }, 2000); // Check every 2 seconds
}

function showWarningWindow(issue) {
  // Prevent multiple warnings or warnings after termination
  if (isShowingWarning || sessionTerminated) return;
  if (warningWindow && !warningWindow.isDestroyed()) return;
  
  isShowingWarning = true;
  console.log('Showing warning window for:', issue);
  
  // Clear any existing resolve check interval
  if (resolveCheckInterval) {
    clearInterval(resolveCheckInterval);
    resolveCheckInterval = null;
  }
  
  warningWindow = new BrowserWindow({
    width: 600,
    height: 500,
    fullscreen: false,
    frame: false,
    kiosk: true,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    closable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });
  
  warningWindow.setAlwaysOnTop(true, 'screen-saver');
  warningWindow.center();
  warningWindow.loadFile('warning.html', { query: { issue: issue } });
  
  // Handle window closed unexpectedly
  warningWindow.on('closed', () => {
    warningWindow = null;
  });
  
  // Start checking if issue is resolved during warning period
  resolveCheckInterval = setInterval(async () => {
    if (!isShowingWarning || sessionTerminated) {
      clearInterval(resolveCheckInterval);
      resolveCheckInterval = null;
      return;
    }
    
    // Check ALL conditions
    const displayResult = screen.getAllDisplays();
    const zoomResult = await checkZoomCamera();
    const bluetoothResult = await checkBluetooth();
    const usbResult = await checkUsbDevices();
    
    const hasDisplayIssue = displayResult.length > 1;
    const hasCameraIssue = !zoomResult.zoomRunning || !zoomResult.cameraInUse;
    const hasBluetoothIssue = bluetoothResult.bluetoothEnabled;
    const hasUsbIssue = usbResult.hasUsbDevices;
    
    if (!hasDisplayIssue && !hasCameraIssue && !hasBluetoothIssue && !hasUsbIssue) {
      console.log('Issue resolved during warning period');
      closeWarningWindow();
    }
  }, 1000);
}

function closeWarningWindow() {
  // Clear the resolve check interval first
  if (resolveCheckInterval) {
    clearInterval(resolveCheckInterval);
    resolveCheckInterval = null;
  }
  
  if (warningWindow && !warningWindow.isDestroyed()) {
    try {
      warningWindow.webContents.send('issue-resolved');
    } catch (e) {
      // Window may already be closing
    }
    warningWindow.close();
    warningWindow = null;
  }
  isShowingWarning = false;
}

function terminateChessSession() {
  console.log('Terminating chess session due to fair play issue');
  
  sessionTerminated = true;
  isShowingWarning = false;
  
  // Stop monitoring
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  
  // Stop resolve checking
  if (resolveCheckInterval) {
    clearInterval(resolveCheckInterval);
    resolveCheckInterval = null;
  }
  
  // Close warning window if open
  if (warningWindow && !warningWindow.isDestroyed()) {
    warningWindow.close();
    warningWindow = null;
  }
  
  // Exit kiosk/fullscreen mode to allow button interaction
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setKiosk(false);
    mainWindow.setSimpleFullScreen(false);
    mainWindow.setFullScreen(false);
    // Keep alwaysOnTop but allow interaction
    mainWindow.setAlwaysOnTop(true, 'floating');
  }
  
  // Load terminated screen in main window (closes chess.com)
  mainWindow.loadFile('terminated.html');
}

function blockShortcuts() {
  // Block ALL common exit/escape shortcuts
  const shortcutsToBlock = [
    'CommandOrControl+Q',      // Quit
    'CommandOrControl+W',      // Close window
    'CommandOrControl+H',      // Hide
    'CommandOrControl+M',      // Minimize
    'Alt+F4',                  // Windows close
    'CommandOrControl+Alt+Escape', // Force quit dialog (partial)
    'Escape',                  // Escape key
    'CommandOrControl+Shift+Escape',
    'F11',                     // Fullscreen toggle
    'CommandOrControl+Shift+F', // Find/Search
    'CommandOrControl+Shift+Q', // macOS logout dialog
    'Command+Shift+Q',          // macOS logout dialog (explicit)
  ];

  shortcutsToBlock.forEach(shortcut => {
    try {
      globalShortcut.register(shortcut, () => {
        // Do nothing - blocks the shortcut
      });
    } catch (e) {
      // Some shortcuts can't be registered
    }
  });

}

app.whenReady().then(() => {
  // Block system sleep
  powerSaveId = powerSaveBlocker.start('prevent-display-sleep');

  createWindow();
  blockShortcuts();
  
  // Check for updates (only in production)
  if (!app.isPackaged) {
    console.log('Skipping auto-update check in development mode');
  } else {
    autoUpdater.checkForUpdatesAndNotify();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Auto-updater event handlers
autoUpdater.on('checking-for-update', () => {
  console.log('Checking for updates...');
  updateStatus = { status: 'checking', version: null, error: null };
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);
  updateStatus = { status: 'downloading', version: info.version, error: null };
});

autoUpdater.on('update-not-available', (info) => {
  console.log('No update available, current version:', app.getVersion());
  updateStatus = { status: 'up-to-date', version: null, error: null };
});

autoUpdater.on('download-progress', (progressObj) => {
  console.log(`Download progress: ${Math.round(progressObj.percent)}%`);
  updateStatus = { status: 'downloading', version: updateStatus.version, progress: Math.round(progressObj.percent), error: null };
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded:', info.version);
  updateStatus = { status: 'ready', version: info.version, error: null };
  // Only prompt if proctor hasn't started yet
  if (!proctorStarted) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'The update will be installed when you quit the app.',
      buttons: ['OK', 'Restart Now']
    }).then((result) => {
      if (result.response === 1) {
        allowQuit = true;
        autoUpdater.quitAndInstall();
      }
    });
  }
});

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err);
  updateStatus = { status: 'error', version: null, error: err.message };
});

// Prevent quit unless allowed
app.on('before-quit', (e) => {
  if (!allowQuit) {
    e.preventDefault();
  }
});

app.on('window-all-closed', () => {
  // Quit if proctor hasn't started yet
  if (!proctorStarted) {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  allowQuit = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
