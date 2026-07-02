/**
 * GENERATED FILE CONTRACT (A.16y.7-protocol-provider-default-and-source-projection)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

export const GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS = [
  {
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
    "providerId": "claude",
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
      ],
      "passthrough": true
    },
    "sourceKind": "claudeConfig"
  },
  {
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
    "providerId": "codex",
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
      "passthrough": true,
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
    "providerId": "opencode",
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
        }
      ],
      "passthrough": true
    },
    "sourceKind": "opencodeServer"
  },
  {
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
    "providerId": "ohMyPi",
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
        }
      ],
      "passthrough": true
    },
    "sourceKind": "ohMyPiAgentDir"
  },
] as const;
