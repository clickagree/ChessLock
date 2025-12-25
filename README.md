# ChessLock

A simple Electron app that runs Chess.com in kiosk mode on macOS.

## Features

- Full-screen kiosk mode
- No menu bar or window decorations
- Prevents accidental navigation away from Chess.com
- Single instance enforcement

## Keyboard Shortcuts

- **Cmd+Shift+Q** - Quit the application
- **Cmd+Shift+F** - Toggle kiosk/fullscreen mode

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the app:
   ```bash
   npm start
   ```

## Building for Distribution

To build a distributable macOS app:

```bash
npm run build
```

This will create a DMG file in the `dist` folder.

## Requirements

- Node.js 18+
- npm or yarn
- macOS

## Notes

- The app prevents opening new windows/popups
- Navigation is restricted to chess.com domains only
- Use the keyboard shortcuts to exit or toggle fullscreen mode
