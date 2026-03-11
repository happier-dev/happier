// Vite/Vitest doesn't resolve RN platform suffixes by default, so keep a stable `.tsx` entrypoint for web/test.
// Metro/Expo resolves `SessionRightPanelTerminalView.native.tsx` (ios/android) and
// `SessionRightPanelTerminalView.web.tsx` (web) automatically.
export { SessionRightPanelTerminalView } from './SessionRightPanelTerminalView.web';

