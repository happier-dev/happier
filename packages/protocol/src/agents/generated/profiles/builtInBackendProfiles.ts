/**
 * GENERATED FILE CONTRACT (A.16y.7-protocol-provider-default-and-source-projection)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { AIBackendProfile } from '../../../profiles/backendProfileSchema.js';

export const GENERATED_BUILT_IN_BACKEND_PROFILES = [
  {
    "compatibility": {},
    "compatibilityByTargetKey": {
      "agent:claude": false,
      "agent:codex": true,
      "agent:gemini": false
    },
    "createdAt": 0,
    "defaultEnabled": true,
    "defaultPermissionModeByAgent": {},
    "defaultPermissionModeByTargetKey": {
      "agent:codex": "default"
    },
    "defaultPersistenceModeByAgent": {},
    "defaultPersistenceModeByTargetKey": {},
    "environmentVariables": [
      {
        "name": "AZURE_OPENAI_API_VERSION",
        "value": "2024-02-15-preview"
      },
      {
        "name": "OPENAI_API_TIMEOUT_MS",
        "value": "600000"
      },
      {
        "name": "API_TIMEOUT_MS",
        "value": "600000"
      }
    ],
    "envVarRequirements": [
      {
        "kind": "secret",
        "name": "AZURE_OPENAI_API_KEY",
        "required": true
      }
    ],
    "id": "azure-openai",
    "isBuiltIn": true,
    "name": "Azure OpenAI",
    "updatedAt": 0,
    "version": "1.0.0"
  },
  {
    "compatibility": {},
    "compatibilityByTargetKey": {
      "agent:claude": false,
      "agent:codex": false,
      "agent:gemini": true
    },
    "createdAt": 0,
    "defaultEnabled": true,
    "defaultPermissionModeByAgent": {},
    "defaultPermissionModeByTargetKey": {
      "agent:gemini": "default"
    },
    "defaultPersistenceModeByAgent": {},
    "defaultPersistenceModeByTargetKey": {},
    "environmentVariables": [
      {
        "name": "GEMINI_MODEL",
        "value": "gemini-2.5-pro"
      }
    ],
    "envVarRequirements": [
      {
        "kind": "secret",
        "name": "GEMINI_API_KEY",
        "required": true
      }
    ],
    "id": "gemini-api-key",
    "isBuiltIn": true,
    "name": "Gemini (API key)",
    "updatedAt": 0,
    "version": "1.0.0"
  },
  {
    "compatibility": {},
    "compatibilityByTargetKey": {
      "agent:claude": false,
      "agent:codex": false,
      "agent:gemini": true
    },
    "createdAt": 0,
    "defaultEnabled": true,
    "defaultPermissionModeByAgent": {},
    "defaultPermissionModeByTargetKey": {
      "agent:gemini": "default"
    },
    "defaultPersistenceModeByAgent": {},
    "defaultPersistenceModeByTargetKey": {},
    "environmentVariables": [
      {
        "name": "GOOGLE_GENAI_USE_VERTEXAI",
        "value": "1"
      },
      {
        "name": "GEMINI_MODEL",
        "value": "gemini-2.5-pro"
      }
    ],
    "envVarRequirements": [
      {
        "kind": "config",
        "name": "GOOGLE_CLOUD_PROJECT",
        "required": true
      },
      {
        "kind": "config",
        "name": "GOOGLE_CLOUD_LOCATION",
        "required": true
      }
    ],
    "id": "gemini-vertex",
    "isBuiltIn": true,
    "name": "Gemini (Vertex AI)",
    "updatedAt": 0,
    "version": "1.0.0"
  },
] as const satisfies ReadonlyArray<AIBackendProfile>;

export const GENERATED_PROVIDER_MIGRATION_SOURCE_PROFILE_IDS = ['deepseek', 'minimax', 'minimax-cn', 'openai', 'zai'] as const;
