import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { cursorConnectedAccountRuntime as portableRuntime } from './portableRuntime.js';
import { createCursorNativeImportMode } from './nativeCredentials.js';
export { activate, cursorPortableAccountRuntime } from './portableRuntime.js';

/** Machine-local import stays out of the Account authentication artifact graph. */
export const cursorConnectedAccountRuntime: ConnectedAccountRuntime = {
  ...portableRuntime,
  authentication: { modes: { ...portableRuntime.authentication.modes, 'native-import': createCursorNativeImportMode() } },
};
