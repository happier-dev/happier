/**
 * GENERATED FILE CONTRACT (A.16y.7-protocol-provider-default-and-source-projection)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

export const GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS = [
  {
    "agentId": "claude",
    "instances": [
      {
        "constants": {},
        "kind": "default"
      }
    ],
    "key": {
      "segments": [
        {
          "kind": "literal",
          "value": "claudeConfig"
        },
        {
          "field": "configDir",
          "kind": "field"
        },
        {
          "field": "projectId",
          "kind": "field"
        }
      ]
    },
    "schema": {
      "fields": [
        {
          "kind": "literal",
          "name": "kind",
          "value": "claudeConfig"
        },
        {
          "kind": "string",
          "max": 10000,
          "min": 1,
          "name": "configDir",
          "nullish": true
        },
        {
          "kind": "string",
          "max": 2000,
          "min": 1,
          "name": "projectId",
          "nullish": true
        }
      ]
    },
    "sourceKind": "claudeConfig"
  },
  {
    "agentId": "codex",
    "instances": [
      {
        "constants": {
          "home": "user"
        },
        "kind": "default"
      },
      {
        "constants": {
          "home": "connectedService"
        },
        "fields": {
          "profileId": "connectedServiceProfileId",
          "serviceId": "connectedServiceId"
        },
        "kind": "connectedServiceProfiles",
        "serviceId": "openai-codex"
      }
    ],
    "key": {
      "segments": [
        {
          "kind": "literal",
          "value": "codexHome"
        },
        {
          "field": "home",
          "kind": "homeMode"
        },
        {
          "field": "connectedServiceId",
          "kind": "conditionalField",
          "when": {
            "equals": "connectedService",
            "field": "home"
          }
        },
        {
          "groupField": "connectedServiceGroupId",
          "kind": "connectedServiceScope",
          "profileField": "connectedServiceProfileId",
          "when": {
            "equals": "connectedService",
            "field": "home"
          }
        },
        {
          "field": "homePath",
          "kind": "field"
        }
      ]
    },
    "schema": {
      "fields": [
        {
          "kind": "literal",
          "name": "kind",
          "value": "codexHome"
        },
        {
          "kind": "enum",
          "name": "home",
          "values": [
            "user",
            "connectedService"
          ]
        },
        {
          "kind": "string",
          "min": 1,
          "name": "homePath",
          "optional": true
        },
        {
          "kind": "string",
          "min": 1,
          "name": "connectedServiceId",
          "optional": true
        },
        {
          "kind": "string",
          "min": 1,
          "name": "connectedServiceProfileId",
          "optional": true
        },
        {
          "kind": "string",
          "min": 1,
          "name": "connectedServiceGroupId",
          "optional": true
        }
      ],
      "refinements": [
        {
          "field": "connectedServiceId",
          "kind": "requiresWhenEquals",
          "when": {
            "equals": "connectedService",
            "field": "home"
          }
        },
        {
          "fields": [
            "connectedServiceId",
            "connectedServiceProfileId",
            "connectedServiceGroupId"
          ],
          "kind": "forbidsWhenEquals",
          "when": {
            "equals": "user",
            "field": "home"
          }
        }
      ]
    },
    "sourceKind": "codexHome"
  },
  {
    "agentId": "opencode",
    "instances": [
      {
        "constants": {
          "managedEndpoint": true
        },
        "kind": "default"
      },
      {
        "byServerIdSettingId": "opencodeServerBaseUrlByServerIdV1",
        "constants": {},
        "field": "baseUrl",
        "kind": "agentSettingOverride",
        "normalization": "httpOrigin",
        "settingId": "opencodeServerBaseUrl"
      }
    ],
    "key": {
      "segments": [
        {
          "kind": "literal",
          "value": "opencodeServer"
        },
        {
          "field": "baseUrl",
          "kind": "field"
        },
        {
          "field": "directory",
          "kind": "field"
        }
      ]
    },
    "schema": {
      "fields": [
        {
          "kind": "literal",
          "name": "kind",
          "value": "opencodeServer"
        },
        {
          "kind": "unknown",
          "name": "baseUrl",
          "optional": true
        },
        {
          "kind": "unknown",
          "name": "directory",
          "optional": true
        },
        {
          "kind": "unknown",
          "name": "managedEndpoint",
          "optional": true
        }
      ]
    },
    "sourceKind": "opencodeServer"
  },
  {
    "agentId": "antigravity",
    "instances": [
      {
        "constants": {},
        "kind": "default"
      }
    ],
    "key": {
      "segments": [
        {
          "kind": "literal",
          "value": "antigravityCliPrint"
        },
        {
          "field": "brainDir",
          "kind": "field"
        }
      ]
    },
    "schema": {
      "fields": [
        {
          "kind": "literal",
          "name": "kind",
          "value": "antigravityCliPrint"
        },
        {
          "kind": "string",
          "max": 10000,
          "min": 1,
          "name": "brainDir",
          "nullish": true
        },
        {
          "kind": "string",
          "max": 2000,
          "min": 1,
          "name": "conversationId",
          "nullish": true
        },
        {
          "kind": "string",
          "max": 10000,
          "min": 1,
          "name": "sourceRevision",
          "nullish": true
        }
      ]
    },
    "sourceKind": "antigravityCliPrint"
  },
  {
    "agentId": "ohMyPi",
    "instances": [
      {
        "constants": {},
        "kind": "default"
      },
      {
        "constants": {},
        "field": "agentDir",
        "kind": "agentSettingOverride",
        "normalization": "configuredPath",
        "settingId": "ohMyPiAgentDir"
      }
    ],
    "key": {
      "segments": [
        {
          "kind": "literal",
          "value": "ohMyPiAgentDir"
        },
        {
          "field": "agentDir",
          "kind": "field"
        }
      ]
    },
    "schema": {
      "fields": [
        {
          "kind": "literal",
          "name": "kind",
          "value": "ohMyPiAgentDir"
        },
        {
          "kind": "string",
          "max": 10000,
          "min": 1,
          "name": "agentDir",
          "nullish": true
        },
        {
          "kind": "string",
          "max": 10000,
          "min": 1,
          "name": "sessionFilePath",
          "nullish": true
        }
      ]
    },
    "sourceKind": "ohMyPiAgentDir"
  },
  {
    "agentId": "pi",
    "instances": [
      {
        "constants": {},
        "kind": "default"
      },
      {
        "constants": {},
        "field": "agentDir",
        "kind": "agentSettingOverride",
        "normalization": "configuredPath",
        "settingId": "piAgentDir"
      }
    ],
    "key": {
      "segments": [
        {
          "kind": "literal",
          "value": "piAgentDir"
        },
        {
          "field": "agentDir",
          "kind": "field"
        }
      ]
    },
    "schema": {
      "fields": [
        {
          "kind": "literal",
          "name": "kind",
          "value": "piAgentDir"
        },
        {
          "kind": "string",
          "max": 10000,
          "min": 1,
          "name": "agentDir",
          "nullish": true
        },
        {
          "kind": "string",
          "max": 10000,
          "min": 1,
          "name": "sessionFile",
          "nullish": true
        }
      ]
    },
    "sourceKind": "piAgentDir"
  },
] as const;
