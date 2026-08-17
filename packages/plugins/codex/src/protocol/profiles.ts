import type { AgentProfile as AIBackendProfile } from '@happier-dev/plugin-sdk/agents';

export const CODEX_BUILT_IN_BACKEND_PROFILES = [
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    envVarRequirements: [{ name: 'AZURE_OPENAI_API_KEY', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'AZURE_OPENAI_API_VERSION', value: '2024-02-15-preview' },
      { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
      { name: 'API_TIMEOUT_MS', value: '600000' },
    ],
    defaultPermissionModeByTargetKey: { 'agent:codex': 'default' },
    defaultPermissionModeByAgent: {},
    defaultPersistenceModeByTargetKey: {},
    defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: { 'agent:claude': false, 'agent:codex': true, 'agent:gemini': false },
    compatibility: {},
    isBuiltIn: true,
    defaultEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    version: '1.0.0',
  },
] as const satisfies ReadonlyArray<AIBackendProfile>;
