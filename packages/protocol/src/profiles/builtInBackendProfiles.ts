import type { AIBackendProfile } from './backendProfileSchema.js';
import { parseBackendTargetKey } from '../backendTargets/backendTargetRef.js';
import { AGENT_PROVIDER_IDS_V1 } from '../providers/agentProviderIdsV1.js';
import { GENERATED_BUILT_IN_BACKEND_PROFILES } from '../providers/generated/profiles/builtInBackendProfiles.js';

export const DEFAULT_BUILT_IN_BACKEND_PROFILES: ReadonlyArray<AIBackendProfile> = GENERATED_BUILT_IN_BACKEND_PROFILES;

export function getBuiltInBackendProfile(id: string): AIBackendProfile | null {
  const normalized = typeof id === 'string' ? id.trim() : '';
  if (!normalized) return null;
  return DEFAULT_BUILT_IN_BACKEND_PROFILES.find((p) => p.id === normalized) ?? null;
}

function addBuiltInBackendAgentId(targetKey: string | undefined, agentIds: Set<string>): void {
  if (!targetKey) return;
  try {
    const parsed = parseBackendTargetKey(targetKey);
    if (parsed.kind === 'builtInAgent') {
      agentIds.add(parsed.agentId);
    }
  } catch {
    // Ignore malformed legacy profile keys here; schema validation owns rejecting them.
  }
}

export const BUILT_IN_BACKEND_AGENT_IDS = Object.freeze((() => {
  const agentIds = new Set<string>(AGENT_PROVIDER_IDS_V1);
  for (const profile of DEFAULT_BUILT_IN_BACKEND_PROFILES) {
    addBuiltInBackendAgentId(profile.requiresMachineLoginTargetKey, agentIds);
    for (const targetKey of Object.keys(profile.defaultPermissionModeByTargetKey ?? {})) {
      addBuiltInBackendAgentId(targetKey, agentIds);
    }
    for (const targetKey of Object.keys(profile.defaultPersistenceModeByTargetKey ?? {})) {
      addBuiltInBackendAgentId(targetKey, agentIds);
    }
    for (const targetKey of Object.keys(profile.compatibilityByTargetKey ?? {})) {
      addBuiltInBackendAgentId(targetKey, agentIds);
    }
  }
  return Array.from(agentIds).sort();
})());

export function isBuiltInBackendAgentId(id: string): boolean {
  const normalized = typeof id === 'string' ? id.trim() : '';
  if (!normalized) return false;
  return BUILT_IN_BACKEND_AGENT_IDS.includes(normalized);
}
