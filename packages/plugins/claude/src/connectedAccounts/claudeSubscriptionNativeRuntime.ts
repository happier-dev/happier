import { readClaudeCodeNativeCredential } from '../agent/auth/services/native/readCredential.js';
import { createClaudeSubscriptionConnectedAccountRuntime } from './claudeSubscriptionRuntime.js';

export { CLAUDE_NATIVE_IMPORT_MODE_ID } from './claudeSubscriptionRuntime.js';

export const claudeSubscriptionConnectedAccountRuntime = createClaudeSubscriptionConnectedAccountRuntime(
  readClaudeCodeNativeCredential,
);
