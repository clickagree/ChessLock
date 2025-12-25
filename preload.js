// Preload script for ChessLock
// This runs in a sandboxed context before the web page loads

const { contextBridge, ipcRenderer } = require('electron');

// Expose APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  startProctor: () => ipcRenderer.send('start-proctor'),
  checkZoomCamera: () => ipcRenderer.invoke('check-zoom-camera'),
  checkDisplays: () => ipcRenderer.invoke('check-displays'),
  checkBluetooth: () => ipcRenderer.invoke('check-bluetooth'),
  checkUsb: () => ipcRenderer.invoke('check-usb'),
  warningTimerExpired: () => ipcRenderer.send('warning-timer-expired'),
  terminateProctor: () => ipcRenderer.send('terminate-proctor'),
  endProctor: () => ipcRenderer.send('end-proctor'),
  onIssueResolved: (callback) => {
    const handler = () => {
      callback();
      ipcRenderer.removeListener('issue-resolved', handler);
    };
    ipcRenderer.on('issue-resolved', handler);
  }
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('ChessLock loaded');
  
  // Disable right-click context menu
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  
  // Send all key presses to main process for exit password detection
  document.addEventListener('keydown', (e) => {
    if (e.key.length === 1) {
      ipcRenderer.send('key-pressed', e.key);
    }
  }, true);

  // Inject End Proctor button on game pages (chess.com or buddyboardgames.com)
  if (window.location.hostname.includes('chess.com') || window.location.hostname.includes('buddyboardgames.com')) {
    const endButton = document.createElement('button');
    endButton.id = 'chesslock-end-proctor';
    endButton.textContent = 'End Proctor';
    endButton.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 999999;
      background: #dc3545;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      transition: background 0.2s;
    `;
    endButton.addEventListener('mouseenter', () => {
      if (!endButton.dataset.counting) {
        endButton.style.background = '#c82333';
      }
    });
    endButton.addEventListener('mouseleave', () => {
      if (!endButton.dataset.counting) {
        endButton.style.background = '#dc3545';
      }
    });
    endButton.addEventListener('click', () => {
      // Prevent multiple clicks during countdown
      if (endButton.dataset.counting) return;
      
      if (confirm('Are you sure you want to end the proctored session?')) {
        endButton.dataset.counting = 'true';
        endButton.style.background = '#6c757d';
        endButton.style.cursor = 'default';
        
        let secondsLeft = 15;
        endButton.textContent = `Ending in ${secondsLeft}...`;
        
        const countdownInterval = setInterval(() => {
          secondsLeft--;
          if (secondsLeft > 0) {
            endButton.textContent = `Ending in ${secondsLeft}...`;
          } else {
            clearInterval(countdownInterval);
            endButton.textContent = 'Ending...';
            ipcRenderer.send('end-proctor');
          }
        }, 1000);
      }
    });
    document.body.appendChild(endButton);

    // Add subtle monitoring indicator in bottom-left corner
    const monitoringBanner = document.createElement('div');
    monitoringBanner.id = 'chesslock-monitoring-banner';
    monitoringBanner.innerHTML = `Proctored`;
    monitoringBanner.style.cssText = `
      position: fixed;
      bottom: 8px;
      left: 8px;
      z-index: 999998;
      background: rgba(107, 255, 70, 0.6);
      color: rgba(255, 255, 255, 0.8);
      padding: 4px 10px;
      border-radius: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11px;
      font-weight: 500;
      pointer-events: none;
    `;
    document.body.appendChild(monitoringBanner);
  }
});
