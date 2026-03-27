import * as ReactNativeWeb from 'react-native-web';
import { unstable_batchedUpdates } from 'react-dom';

// Re-export the full React Native Web surface, but add `unstable_batchedUpdates`.
//
// Some React Native ecosystem libraries (e.g. `@legendapp/list`) import
// `unstable_batchedUpdates` from `react-native`. On web, Expo aliases `react-native`
// to `react-native-web`, which does not export that symbol. Without this shim,
// those libraries crash at runtime with:
//   `TypeError: unstable_batchedUpdates is not a function`
//
// This shim is wired up in `apps/ui/metro.config.js` for platform === 'web'.
export * from 'react-native-web';

export { unstable_batchedUpdates };

export default ReactNativeWeb;
