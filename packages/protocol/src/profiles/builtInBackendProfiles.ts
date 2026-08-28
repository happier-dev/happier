import type { AIBackendProfile } from './backendProfileSchema.js';
import { parseBackendTargetKey } from '../backends/targets/backendTargetRef.js';
import { AGENT_PROVIDER_IDS_V1 } from '../generated/providers/agentProviderIdsV1.js';
// Product-curated launch and migration presets. These are global Protocol host
// policy, not Agent-authored contributions: plugin activation must not redefine
// built-in profile ids, credentials, or compatibility.
export const DEFAULT_BUILT_IN_BACKEND_PROFILES: ReadonlyArray<AIBackendProfile> = [
  {
    id: 'azure-openai', name: 'Azure OpenAI',
    envVarRequirements: [{ name: 'AZURE_OPENAI_API_KEY', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'AZURE_OPENAI_API_VERSION', value: '2024-02-15-preview' },
      { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
      { name: 'API_TIMEOUT_MS', value: '600000' },
    ],
    defaultPermissionModeByTargetKey: { 'agent:codex': 'default' },
    defaultPermissionModeByAgent: {}, defaultPersistenceModeByTargetKey: {}, defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: { 'agent:claude': false, 'agent:codex': true, 'agent:gemini': false },
    compatibility: {}, isBuiltIn: true, defaultEnabled: true, createdAt: 0, updatedAt: 0, version: '1.0.0',
  },
  {
    id: 'gemini-api-key', name: 'Gemini (API key)',
    envVarRequirements: [{ name: 'GEMINI_API_KEY', kind: 'secret', required: true }],
    environmentVariables: [{ name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' }],
    defaultPermissionModeByTargetKey: { 'agent:gemini': 'default' },
    defaultPermissionModeByAgent: {}, defaultPersistenceModeByTargetKey: {}, defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: { 'agent:claude': false, 'agent:codex': false, 'agent:gemini': true },
    compatibility: {}, isBuiltIn: true, defaultEnabled: true, createdAt: 0, updatedAt: 0, version: '1.0.0',
  },
  {
    id: 'gemini-vertex', name: 'Gemini (Vertex AI)',
    envVarRequirements: [
      { name: 'GOOGLE_CLOUD_PROJECT', kind: 'config', required: true },
      { name: 'GOOGLE_CLOUD_LOCATION', kind: 'config', required: true },
    ],
    environmentVariables: [
      { name: 'GOOGLE_GENAI_USE_VERTEXAI', value: '1' },
      { name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' },
    ],
    defaultPermissionModeByTargetKey: { 'agent:gemini': 'default' },
    defaultPermissionModeByAgent: {}, defaultPersistenceModeByTargetKey: {}, defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: { 'agent:claude': false, 'agent:codex': false, 'agent:gemini': true },
    compatibility: {}, isBuiltIn: true, defaultEnabled: true, createdAt: 0, updatedAt: 0, version: '1.0.0',
  },
];
export const PROVIDER_MIGRATION_SOURCE_PROFILE_IDS = Object.freeze(
  ['deepseek', 'minimax', 'minimax-cn', 'openai', 'zai'],
);

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
