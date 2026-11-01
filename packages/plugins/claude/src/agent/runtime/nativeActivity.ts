import { isClaudeSidechainRuntimeEvidence, isSidechainSessionHook } from '../hooks/sidechain.js';
import { isReplayClaudeAgentSdkMessage } from './remote/sdk/providerActivity.js';

/** Primary native evidence may establish SDK session identity; replay and child traffic may not. */
export function isClaudePrimaryNativeActivity(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const hookEvent = record.hook_event_name ?? record.hookEventName ?? record.eventName;
  return !isReplayClaudeAgentSdkMessage(value)
    && !isClaudeSidechainRuntimeEvidence(value)
    && !isSidechainSessionHook(record)
    && hookEvent !== 'PermissionRequestCompleted';
}
