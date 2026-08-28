// TypeScript's generic resolver does not apply React Native platform suffixes.
// Metro selects the adjacent .native/.web implementation at bundle time.
export { TerminalQaScreen as default, TerminalQaScreen } from './TerminalQaScreen.native';
