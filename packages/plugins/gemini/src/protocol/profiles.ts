import type { AIBackendProfile } from '@happier-dev/plugin-sdk/manifest';

export const GEMINI_BUILT_IN_BACKEND_PROFILES = [
  {
    id: 'gemini-api-key',
    name: 'Gemini (API key)',
    envVarRequirements: [{ name: 'GEMINI_API_KEY', kind: 'secret', required: true }],
    environmentVariables: [{ name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' }],
    defaultPermissionModeByTargetKey: { 'agent:gemini': 'default' },
    defaultPermissionModeByAgent: {},
    defaultPersistenceModeByTargetKey: {},
    defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: { 'agent:claude': false, 'agent:codex': false, 'agent:gemini': true },
    compatibility: {},
    isBuiltIn: true,
    defaultEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    version: '1.0.0',
  },
  {
    id: 'gemini-vertex',
    name: 'Gemini (Vertex AI)',
    envVarRequirements: [
      { name: 'GOOGLE_CLOUD_PROJECT', kind: 'config', required: true },
      { name: 'GOOGLE_CLOUD_LOCATION', kind: 'config', required: true },
    ],
    environmentVariables: [
      { name: 'GOOGLE_GENAI_USE_VERTEXAI', value: '1' },
      { name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' },
    ],
    defaultPermissionModeByTargetKey: { 'agent:gemini': 'default' },
    defaultPermissionModeByAgent: {},
    defaultPersistenceModeByTargetKey: {},
    defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: { 'agent:claude': false, 'agent:codex': false, 'agent:gemini': true },
    compatibility: {},
    isBuiltIn: true,
    defaultEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    version: '1.0.0',
  },
] as const satisfies ReadonlyArray<AIBackendProfile>;
