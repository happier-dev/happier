/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry list for first-party bundled
 * provider settings plugins.
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

export type BundledProviderSettingsDescriptor = Readonly<{
    agentId: string;
    descriptor: Readonly<Record<string, unknown>>;
}>;

export const BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS: readonly BundledProviderSettingsDescriptor[] = Object.freeze([
    Object.freeze({
        agentId: 'auggie',
        descriptor: Object.freeze({
  "descriptorId": "auggie.providerSettings.v1"
} as const),
    }),
    Object.freeze({
        agentId: 'claude',
        descriptor: Object.freeze({
  "descriptorId": "claude.providerSettings.v1",
  "icon": {
    "color": {
      "kind": "theme",
      "token": "orange"
    },
    "ionName": "sparkles-outline"
  },
  "kind": "providerSettings.v1",
  "providerId": "claude",
  "settings": {
    "claudeCodeExperimentalAgentTeamsEnabled": {
      "default": false,
      "description": "Force-enable Claude experimental agent teams",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeLocalPermissionBridgeEnabled": {
      "default": true,
      "description": "Enable local Claude permission bridge",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeLocalPermissionBridgeTimeoutSeconds": {
      "default": 600,
      "description": "Local permission bridge timeout in seconds",
      "schema": {
        "int": true,
        "kind": "number",
        "min": 1
      },
      "storageScope": "account"
    },
    "claudeLocalPermissionBridgeWaitIndefinitely": {
      "default": true,
      "description": "Keep local permission requests open until the user responds",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeRemoteAdvancedOptionsJson": {
      "default": "",
      "description": "Advanced Claude remote options JSON",
      "schema": {
        "kind": "jsonObjectString",
        "maxLength": 16384
      },
      "storageScope": "account"
    },
    "claudeRemoteAgentSdkEnabled": {
      "default": true,
      "description": "Use Claude Agent SDK in remote mode",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeRemoteDebugCategories": {
      "default": [],
      "description": "Claude Code debug categories filter (remote)",
      "schema": {
        "element": {
          "kind": "enum",
          "values": [
            "api",
            "mcp",
            "hooks",
            "file",
            "1p"
          ]
        },
        "kind": "array",
        "max": 5
      },
      "storageScope": "account"
    },
    "claudeRemoteDebugEnabled": {
      "default": false,
      "description": "Enable Claude Code debug mode (remote)",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeRemoteDisableTodos": {
      "default": false,
      "description": "Disable TODO generation in Claude remote mode",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeRemoteEnableFileCheckpointing": {
      "default": false,
      "description": "Enable Claude file checkpointing",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeRemoteMaxThinkingTokens": {
      "default": null,
      "description": "Maximum Claude thinking tokens override",
      "schema": {
        "int": true,
        "kind": "number",
        "min": 1,
        "nullable": true
      },
      "storageScope": "account"
    },
    "claudeRemoteSettingSources": {
      "default": "user_project",
      "description": "Legacy Claude settings source mode",
      "schema": {
        "kind": "enum",
        "values": [
          "project",
          "user_project",
          "none"
        ]
      },
      "storageScope": "account"
    },
    "claudeRemoteSettingSourcesV2": {
      "default": [
        "user",
        "project",
        "local"
      ],
      "description": "Claude settings sources",
      "schema": {
        "element": {
          "kind": "enum",
          "values": [
            "user",
            "project",
            "local"
          ]
        },
        "kind": "array",
        "max": 3
      },
      "storageScope": "account"
    },
    "claudeRemoteStrictMcpServerConfig": {
      "default": false,
      "description": "Fail if Claude MCP server config is invalid",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeRemoteVerboseEnabled": {
      "default": false,
      "description": "Enable Claude Code verbose logging (remote)",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeUnifiedTerminalEnabled": {
      "default": false,
      "description": "Enable Claude unified terminal runtime",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account"
    },
    "claudeUnifiedTerminalHost": {
      "default": "auto",
      "description": "Claude unified terminal host adapter preference",
      "schema": {
        "kind": "enum",
        "values": [
          "auto",
          "tmux",
          "zellij"
        ]
      },
      "storageScope": "account"
    }
  },
  "subagentSettingsSections": [
    {
      "footer": {
        "key": "subAgentGuidance.settings.providers.claude.footer"
      },
      "id": "claudeTeams",
      "items": [
        {
          "iconIonName": "sparkles-outline",
          "id": "claudeTeamsProviderSettings",
          "route": "/(app)/settings/providers/claude",
          "subtitle": {
            "key": "subAgentGuidance.settings.providers.claude.openSubtitle"
          },
          "title": {
            "key": "subAgentGuidance.settings.providers.claude.openTitle"
          }
        }
      ],
      "title": {
        "key": "subAgentGuidance.settings.providers.claude.title"
      }
    }
  ],
  "title": {
    "key": "settingsProviders.plugins.claude.title"
  },
  "uiSections": [
    {
      "fields": [
        {
          "key": "claudeCodeExperimentalAgentTeamsEnabled",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeCodeExperimentalAgentTeamsEnabled.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeCodeExperimentalAgentTeamsEnabled.title"
          }
        }
      ],
      "footer": {
        "key": "settingsProviders.plugins.claude.sections.claudeCodeExperiments.footer"
      },
      "id": "claudeCodeExperiments",
      "title": {
        "key": "settingsProviders.plugins.claude.sections.claudeCodeExperiments.title"
      }
    },
    {
      "fields": [
        {
          "key": "claudeRemoteAgentSdkEnabled",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteAgentSdkEnabled.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteAgentSdkEnabled.title"
          }
        },
        {
          "key": "claudeRemoteDebugEnabled",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugEnabled.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugEnabled.title"
          }
        },
        {
          "key": "claudeRemoteVerboseEnabled",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteVerboseEnabled.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteVerboseEnabled.title"
          }
        },
        {
          "enumOptions": [
            {
              "id": "api",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.api.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.api.title"
              }
            },
            {
              "id": "mcp",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.title"
              }
            },
            {
              "id": "hooks",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.title"
              }
            },
            {
              "id": "file",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.file.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.file.title"
              }
            },
            {
              "id": "1p",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.title"
              }
            }
          ],
          "key": "claudeRemoteDebugCategories",
          "kind": "multiEnum",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.title"
          }
        },
        {
          "enumOptions": [
            {
              "id": "user",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.user.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.user.title"
              }
            },
            {
              "id": "project",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.project.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.project.title"
              }
            },
            {
              "id": "local",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.title"
              }
            }
          ],
          "key": "claudeRemoteSettingSourcesV2",
          "kind": "multiEnum",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.title"
          }
        },
        {
          "key": "claudeLocalPermissionBridgeEnabled",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeEnabled.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeEnabled.title"
          }
        },
        {
          "key": "claudeLocalPermissionBridgeWaitIndefinitely",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeWaitIndefinitely.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeWaitIndefinitely.title"
          }
        },
        {
          "key": "claudeLocalPermissionBridgeTimeoutSeconds",
          "kind": "number",
          "numberSpec": {
            "min": 1,
            "placeholder": {
              "key": "common.default"
            },
            "step": 30
          },
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeTimeoutSeconds.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeTimeoutSeconds.title"
          }
        },
        {
          "key": "claudeRemoteEnableFileCheckpointing",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteEnableFileCheckpointing.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteEnableFileCheckpointing.title"
          }
        },
        {
          "key": "claudeRemoteMaxThinkingTokens",
          "kind": "number",
          "numberSpec": {
            "min": 1,
            "placeholder": {
              "key": "common.default"
            },
            "step": 100
          },
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteMaxThinkingTokens.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteMaxThinkingTokens.title"
          }
        },
        {
          "key": "claudeRemoteDisableTodos",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteDisableTodos.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteDisableTodos.title"
          }
        },
        {
          "key": "claudeRemoteStrictMcpServerConfig",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteStrictMcpServerConfig.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteStrictMcpServerConfig.title"
          }
        },
        {
          "key": "claudeRemoteAdvancedOptionsJson",
          "kind": "json",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteAdvancedOptionsJson.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeRemoteAdvancedOptionsJson.title"
          }
        }
      ],
      "footer": {
        "key": "settingsProviders.plugins.claude.sections.claudeRemoteSdk.footer"
      },
      "id": "claudeRemoteSdk",
      "title": {
        "key": "settingsProviders.plugins.claude.sections.claudeRemoteSdk.title"
      }
    },
    {
      "fields": [
        {
          "key": "claudeUnifiedTerminalEnabled",
          "kind": "boolean",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalEnabled.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalEnabled.title"
          }
        },
        {
          "enumOptions": [
            {
              "id": "auto",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.title"
              }
            },
            {
              "id": "tmux",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.title"
              }
            },
            {
              "id": "zellij",
              "subtitle": {
                "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.title"
              }
            }
          ],
          "key": "claudeUnifiedTerminalHost",
          "kind": "enum",
          "subtitle": {
            "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.title"
          }
        }
      ],
      "footer": {
        "key": "settingsProviders.plugins.claude.sections.claudeUnifiedTerminal.footer"
      },
      "id": "claudeUnifiedTerminal",
      "title": {
        "key": "settingsProviders.plugins.claude.sections.claudeUnifiedTerminal.title"
      }
    }
  ]
} as const),
    }),
    Object.freeze({
        agentId: 'copilot',
        descriptor: Object.freeze({
  "descriptorId": "copilot.providerSettings.v1"
} as const),
    }),
    Object.freeze({
        agentId: 'kilo',
        descriptor: Object.freeze({
  "descriptorId": "kilo.providerSettings.v1"
} as const),
    }),
    Object.freeze({
        agentId: 'kimi',
        descriptor: Object.freeze({
  "descriptorId": "kimi.providerSettings.v1"
} as const),
    }),
    Object.freeze({
        agentId: 'opencode',
        descriptor: Object.freeze({
  "descriptorId": "opencode.providerSettings.v1",
  "icon": {
    "color": {
      "kind": "theme",
      "token": "blue"
    },
    "ionName": "code-slash-outline"
  },
  "kind": "providerSettings.v1",
  "providerId": "opencode",
  "settings": {
    "opencodeBackendMode": {
      "default": "server",
      "description": "Preferred OpenCode backend mode",
      "schema": {
        "kind": "enum",
        "values": [
          "server",
          "acp"
        ]
      },
      "storageScope": "account"
    },
    "opencodeServerBaseUrl": {
      "default": "",
      "description": "Optional override for a user-managed OpenCode server URL",
      "schema": {
        "kind": "string"
      },
      "storageScope": "account"
    },
    "opencodeServerBaseUrlByServerIdV1": {
      "default": {},
      "description": "Per-server overrides for user-managed OpenCode server URLs",
      "schema": {
        "kind": "stringRecord"
      },
      "storageScope": "account"
    }
  },
  "title": {
    "key": "settingsProviders.plugins.opencode.title"
  },
  "uiSections": [
    {
      "fields": [
        {
          "enumOptions": [
            {
              "id": "server",
              "subtitle": {
                "key": "settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.server.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.server.title"
              }
            },
            {
              "id": "acp",
              "subtitle": {
                "key": "settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.acp.subtitle"
              },
              "title": {
                "key": "settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.acp.title"
              }
            }
          ],
          "key": "opencodeBackendMode",
          "kind": "enum",
          "subtitle": {
            "key": "settingsProviders.plugins.opencode.fields.opencodeBackendMode.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.opencode.fields.opencodeBackendMode.title"
          }
        }
      ],
      "footer": {
        "key": "settingsProviders.plugins.opencode.sections.backendMode.footer"
      },
      "id": "opencodeBackendMode",
      "title": {
        "key": "settingsProviders.plugins.opencode.sections.backendMode.title"
      }
    },
    {
      "fields": [
        {
          "binding": {
            "byServerIdSettingKey": "opencodeServerBaseUrlByServerIdV1",
            "fallbackSettingKey": "opencodeServerBaseUrl",
            "kind": "perActiveServer"
          },
          "key": "opencodeServerBaseUrl",
          "kind": "text",
          "subtitle": {
            "key": "settingsProviders.plugins.opencode.fields.opencodeServerBaseUrl.subtitle"
          },
          "title": {
            "key": "settingsProviders.plugins.opencode.fields.opencodeServerBaseUrl.title"
          }
        }
      ],
      "footer": {
        "key": "settingsProviders.plugins.opencode.sections.server.footer"
      },
      "id": "opencodeServer",
      "title": {
        "key": "settingsProviders.plugins.opencode.sections.server.title"
      }
    }
  ]
} as const),
    }),
    Object.freeze({
        agentId: 'pi',
        descriptor: Object.freeze({
  "descriptorId": "pi.providerSettings.v1"
} as const),
    }),
]);

export const BUNDLED_PROVIDER_SETTINGS_PLUGINS: readonly ProviderSettingsPlugin[] = Object.freeze([
]);
