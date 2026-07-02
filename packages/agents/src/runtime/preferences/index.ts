import type { AgentId } from '../../types.js';
import { getAgentCliRuntimeSpec } from '../../cli/runtime.js';
import { getAgentRuntimeKindsManifest } from '../../runtimeKinds.js';
import type { RuntimePreferencesAdapter } from '../adjunctAdapters/types.js';
import {
  resolveCodexSessionRuntimePreferences,
  resolveCodexRuntimeBackendMode,
  resolveCodexSpawnExtrasForRuntime,
  resolveCodexSpawnExtrasFromSettings,
} from './codex.js';
export type { CodexBackendMode } from './codex.js';
export type { KimiAcpPythonSelector } from '../../providerSettings/index.js';
export {
  isCodexVendorResumeBackendEnabled,
  resolveCodexSessionRuntimePreferences,
  resolveCodexRuntimeBackendMode,
  resolveCodexSpawnExtrasForRuntime,
  resolveCodexSpawnExtrasFromSettings,
} from './codex.js';

export function getProviderRuntimePreferencesAdapter(agentId: AgentId): RuntimePreferencesAdapter {
  const runtimeSpec = getAgentCliRuntimeSpec(agentId);
  const defaultRuntimeKind = getAgentRuntimeKindsManifest(agentId)?.defaultKind ?? null;

  return {
    sourcePreference: {
      default: runtimeSpec.sourcePreferenceDefault,
    },
    ...(defaultRuntimeKind ? { defaultRuntimeKind: { default: defaultRuntimeKind } } : {}),
  };
}
