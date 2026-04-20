import type { AgentId } from '../../types.js';
import { getProviderCliRuntimeSpec } from '../../providers/providerCliRuntime.js';
import { getAgentRuntimeKindsManifest } from '../../runtimeKinds.js';
import type { RuntimePreferencesAdapter } from '../adjunctAdapters/types.js';
import {
  resolveCodexSessionRuntimePreferences,
  resolveCodexRuntimeBackendMode,
  resolveCodexSpawnExtrasForRuntime,
  resolveCodexSpawnExtrasFromSettings,
} from './codex.js';
import { resolveOpenCodeSessionRuntimePreferences } from './opencode.js';
export type { CodexBackendMode } from './codex.js';
export type { OpenCodeBackendMode } from '../../providerSettings/index.js';
export {
  isCodexVendorResumeBackendEnabled,
  resolveCodexSessionRuntimePreferences,
  resolveCodexRuntimeBackendMode,
  resolveCodexSpawnExtrasForRuntime,
  resolveCodexSpawnExtrasFromSettings,
} from './codex.js';
export { resolveOpenCodeSessionRuntimePreferences } from './opencode.js';

export function getProviderRuntimePreferencesAdapter(agentId: AgentId): RuntimePreferencesAdapter {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const defaultRuntimeKind = getAgentRuntimeKindsManifest(agentId)?.defaultKind ?? null;

  return {
    sourcePreference: {
      default: runtimeSpec.sourcePreferenceDefault,
    },
    ...(defaultRuntimeKind ? { defaultRuntimeKind: { default: defaultRuntimeKind } } : {}),
  };
}
