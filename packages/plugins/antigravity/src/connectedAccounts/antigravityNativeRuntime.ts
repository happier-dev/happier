import { readAgyNativeCredential } from './nativeCredentials.js';
import { createAntigravityConnectedAccountRuntime } from './antigravityConnectedAccountRuntime.js';

export const antigravityConnectedAccountRuntime = createAntigravityConnectedAccountRuntime(readAgyNativeCredential);
