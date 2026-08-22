import type { AgentId } from '../../types.js';
import { getAgentCliRuntimeSpec } from '../../cli/runtime.js';
import { getAgentRuntimeKindsManifest } from '../../runtimeKinds.js';
import type { RuntimePreferencesAdapter } from '../adjunctAdapters/types.js';

/**
 * Bundled runtime preference facts for an Agent.
 *
 * Every field is a bundled fact, so an externally installed Agent legitimately
 * yields an empty adapter rather than a bundled Agent's preferences.
 */
export function getProviderRuntimePreferencesAdapter(agentId: AgentId): RuntimePreferencesAdapter {
  const runtimeSpec = getAgentCliRuntimeSpec(agentId);
  const defaultRuntimeKind = getAgentRuntimeKindsManifest(agentId)?.defaultKind ?? null;

  return {
    ...(runtimeSpec ? { sourcePreference: { default: runtimeSpec.sourcePreferenceDefault } } : {}),
    ...(defaultRuntimeKind ? { defaultRuntimeKind: { default: defaultRuntimeKind } } : {}),
  };
}
