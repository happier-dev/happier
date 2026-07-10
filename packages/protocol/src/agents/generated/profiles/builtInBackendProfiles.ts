/**
 * GENERATED FILE CONTRACT (A.16y.7-protocol-provider-default-and-source-projection)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { AIBackendProfile } from '../../../profiles/backendProfileSchema.js';

export const GENERATED_BUILT_IN_BACKEND_PROFILES = [
  {
    "authMode": "machineLogin",
    "compatibility": {},
    "compatibilityByTargetKey": {
      "agent:claude": true,
      "agent:codex": false,
      "agent:gemini": false
    },
    "createdAt": 0,
    "defaultEnabled": true,
    "defaultPermissionModeByAgent": {},
    "defaultPermissionModeByTargetKey": {
      "agent:claude": "default"
    },
    "defaultPersistenceModeByAgent": {},
    "defaultPersistenceModeByTargetKey": {},
    "environmentVariables": [],
    "envVarRequirements": [],
    "id": "anthropic",
    "isBuiltIn": true,
    "name": "Anthropic (Default)",
    "requiresMachineLoginTargetKey": "agent:claude",
    "updatedAt": 0,
    "version": "1.0.0"
  },
  {
    "compatibility": {},
    "compatibilityByTargetKey": {
      "agent:claude": true,
      "agent:codex": false,
      "agent:gemini": false
    },
    "createdAt": 0,
    "defaultEnabled": true,
    "defaultPermissionModeByAgent": {},
    "defaultPermissionModeByTargetKey": {
      "agent:claude": "default"
    },
    "defaultPersistenceModeByAgent": {},
    "defaultPersistenceModeByTargetKey": {},
    "environmentVariables": [
      {
        "name": "ANTHROPIC_BASE_URL",
        "value": "${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}"
      },
      {
        "name": "ANTHROPIC_AUTH_TOKEN",
        "value": "${DEEPSEEK_AUTH_TOKEN}"
      },
      {
        "name": "API_TIMEOUT_MS",
        "value": "${DEEPSEEK_API_TIMEOUT_MS:-600000}"
      },
      {
        "name": "ANTHROPIC_MODEL",
        "value": "${DEEPSEEK_MODEL:-deepseek-reasoner}"
      },
      {
        "name": "ANTHROPIC_SMALL_FAST_MODEL",
        "value": "${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-chat}"
      },
      {
        "name": "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "value": "${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
      }
    ],
    "envVarRequirements": [
      {
        "kind": "secret",
        "name": "DEEPSEEK_AUTH_TOKEN",
        "required": true
      }
    ],
    "id": "deepseek",
    "isBuiltIn": true,
    "name": "DeepSeek (Reasoner)",
    "updatedAt": 0,
    "version": "1.0.0"
  },
  {
    "compatibility": {},
    "compatibilityByTargetKey": {
      "agent:claude": true,
      "agent:codex": false,
      "agent:gemini": false
    },
    "createdAt": 0,
    "defaultEnabled": true,
    "defaultPermissionModeByAgent": {},
    "defaultPermissionModeByTargetKey": {
      "agent:claude": "default"
    },
    "defaultPersistenceModeByAgent": {},
    "defaultPersistenceModeByTargetKey": {},
    "environmentVariables": [
      {
        "name": "ANTHROPIC_BASE_URL",
        "value": "${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}"
      },
      {
        "name": "ANTHROPIC_AUTH_TOKEN",
        "value": "${Z_AI_AUTH_TOKEN}"
      },
      {
        "name": "API_TIMEOUT_MS",
        "value": "${Z_AI_API_TIMEOUT_MS:-3000000}"
      },
      {
        "name": "ANTHROPIC_MODEL",
        "value": "${Z_AI_MODEL:-GLM-4.6}"
      },
      {
        "name": "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "value": "${Z_AI_OPUS_MODEL:-GLM-4.6}"
      },
      {
        "name": "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "value": "${Z_AI_SONNET_MODEL:-GLM-4.6}"
      },
      {
        "name": "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "value": "${Z_AI_HAIKU_MODEL:-GLM-4.5-Air}"
      }
    ],
    "envVarRequirements": [
      {
        "kind": "secret",
        "name": "Z_AI_AUTH_TOKEN",
        "required": true
      }
    ],
    "id": "zai",
    "isBuiltIn": true,
    "name": "Z.AI (GLM-4.6)",
    "updatedAt": 0,
    "version": "1.0.0"
  },
  {
    "authMode": "machineLogin",
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
    "environmentVariables": [],
    "envVarRequirements": [],
    "id": "codex",
    "isBuiltIn": true,
    "name": "Codex (Default)",
    "requiresMachineLoginTargetKey": "agent:codex",
    "updatedAt": 0,
    "version": "1.0.0"
  },
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
        "name": "OPENAI_BASE_URL",
        "value": "https://api.openai.com/v1"
      },
      {
        "name": "OPENAI_MODEL",
        "value": "gpt-5-codex-high"
      },
      {
        "name": "OPENAI_API_TIMEOUT_MS",
        "value": "600000"
      },
      {
        "name": "OPENAI_SMALL_FAST_MODEL",
        "value": "gpt-5-codex-low"
      },
      {
        "name": "API_TIMEOUT_MS",
        "value": "600000"
      },
      {
        "name": "CODEX_SMALL_FAST_MODEL",
        "value": "gpt-5-codex-low"
      }
    ],
    "envVarRequirements": [
      {
        "kind": "secret",
        "name": "OPENAI_API_KEY",
        "required": true
      }
    ],
    "id": "openai",
    "isBuiltIn": true,
    "name": "OpenAI (GPT-5)",
    "updatedAt": 0,
    "version": "1.0.0"
  },
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
