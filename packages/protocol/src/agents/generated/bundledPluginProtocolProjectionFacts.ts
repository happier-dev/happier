/**
 * GENERATED FILE. DO NOT EDIT.
 *
 * Private generator-owned data used to retain the two protocol projection
 * values that are not yet serialized in plugin final artifacts. The canonical
 * bundled-plugin generator is this file's sole producer and consumer.
 * Remove this sidecar once those owned values are serialized in existing
 * plugin artifacts.
 */

export const BUNDLED_PLUGIN_PROTOCOL_PROJECTION_FACTS = Object.freeze(
[
  {
    "packageName": "@happier-dev/plugins-claude",
    "pluginId": "happier.agent.claude",
    "pluginPackageId": "claude",
    "protocolMemoryDefaults": {
      "agentId": "claude",
      "summarizerBackendId": "claude"
    }
  },
  {
    "packageName": "@happier-dev/plugins-codex",
    "pluginId": "happier.agent.codex",
    "pluginPackageId": "codex",
    "protocolBuiltInBackendProfiles": {
      "agentId": "codex",
      "profiles": [
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
        }
      ]
    }
  },
  {
    "packageName": "@happier-dev/plugins-gemini",
    "pluginId": "happier.agent.gemini",
    "pluginPackageId": "gemini",
    "protocolBuiltInBackendProfiles": {
      "agentId": "gemini",
      "profiles": [
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
        }
      ]
    }
  }
] satisfies readonly Readonly<{
  packageName: string;
  pluginId: string;
  pluginPackageId: string;
  protocolBuiltInBackendProfiles?: Readonly<{
    agentId: string;
    profiles: readonly Readonly<Record<string, unknown>>[];
  }>;
  protocolMemoryDefaults?: Readonly<{
    agentId: string;
    summarizerBackendId: string;
  }>;
}>[]);
