/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (AGENT-SETTINGS-SDK-1)
 *
 * This file is the host-side generated bundled agent-settings contribution list.
 * It stores plugin-authored data only; host packages compile it into validation locally.
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { PluginAgentSettingsContributionV1 } from '@happier-dev/protocol';

export const BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS: readonly PluginAgentSettingsContributionV1[] = Object.freeze([
  Object.freeze({
  "agentId": "antigravity",
  "fields": [
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "enum"
      },
      "default": "auto",
      "description": "Preferred Antigravity runtime mode",
      "id": "antigravityRuntimeMode",
      "schema": {
        "kind": "enum",
        "values": [
          "auto",
          "cliPrint",
          "sdk"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "auto",
            "subtitle": {
              "key": "settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.auto.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.auto.title"
            }
          },
          {
            "id": "cliPrint",
            "subtitle": {
              "key": "settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.cliPrint.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.cliPrint.title"
            }
          },
          {
            "id": "sdk",
            "subtitle": {
              "key": "settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.sdk.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.sdk.title"
            }
          }
        ],
        "kind": "enum",
        "subtitle": {
          "key": "settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.title"
        }
      }
    }
  ],
  "id": "antigravity.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "blue"
      },
      "ionName": "rocket-outline"
    },
    "sections": [
      {
        "fields": [
          "antigravityRuntimeMode"
        ],
        "footer": {
          "key": "settingsAgents.plugins.antigravity.sections.runtime.footer"
        },
        "id": "antigravityRuntime",
        "title": {
          "key": "settingsAgents.plugins.antigravity.sections.runtime.title"
        }
      }
    ],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.antigravity.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "auggie",
  "fields": [],
  "id": "auggie.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "green"
      },
      "ionName": "sparkles-outline"
    },
    "sections": [],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.auggie.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "claude",
  "fields": [
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": true,
      "description": "Use Claude Agent SDK in remote mode",
      "id": "claudeRemoteAgentSdkEnabled",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteAgentSdkEnabled.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteAgentSdkEnabled.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": false,
      "description": "Enable Claude unified terminal runtime",
      "id": "claudeUnifiedTerminalEnabled",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalEnabled.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalEnabled.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "enum"
      },
      "default": "auto",
      "description": "Claude unified terminal host adapter preference",
      "id": "claudeUnifiedTerminalHost",
      "schema": {
        "kind": "enum",
        "values": [
          "auto",
          "tmux",
          "zellij"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "auto",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.title"
            }
          },
          {
            "id": "tmux",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.title"
            }
          },
          {
            "id": "zellij",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.title"
            }
          }
        ],
        "kind": "enum",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "enum"
      },
      "default": "ask_every_time",
      "description": "Default action for Claude heavy-session resume choice prompts",
      "id": "claudeUnifiedTerminalResumeChoice",
      "schema": {
        "kind": "enum",
        "values": [
          "ask_every_time",
          "resume_from_summary",
          "resume_full_session"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "ask_every_time",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.ask_every_time.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.ask_every_time.title"
            }
          },
          {
            "id": "resume_from_summary",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_from_summary.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_from_summary.title"
            }
          },
          {
            "id": "resume_full_session",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_full_session.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_full_session.title"
            }
          }
        ],
        "kind": "enum",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.title"
        }
      }
    },
    {
      "default": "user_project",
      "description": "Legacy Claude settings source mode",
      "id": "claudeRemoteSettingSources",
      "schema": {
        "kind": "enum",
        "values": [
          "project",
          "user_project",
          "none"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "project",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.project.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.project.title"
            }
          },
          {
            "id": "user_project",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.user_project.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.user_project.title"
            }
          },
          {
            "id": "none",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.none.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.options.none.title"
            }
          }
        ],
        "kind": "enum",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSources.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "serializeCurrentRule": "orderedEnumArrayJoin",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "enum"
      },
      "default": [
        "user",
        "project",
        "local"
      ],
      "description": "Claude settings sources",
      "id": "claudeRemoteSettingSourcesV2",
      "schema": {
        "kind": "enumArray",
        "max": 3,
        "values": [
          "user",
          "project",
          "local"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "user",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.user.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.user.title"
            }
          },
          {
            "id": "project",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.project.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.project.title"
            }
          },
          {
            "id": "local",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.title"
            }
          }
        ],
        "kind": "multiEnum",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": true,
      "description": "Enable local Claude permission bridge",
      "id": "claudeLocalPermissionBridgeEnabled",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeEnabled.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeEnabled.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": true,
      "description": "Keep local permission requests open until the user responds",
      "id": "claudeLocalPermissionBridgeWaitIndefinitely",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeWaitIndefinitely.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeWaitIndefinitely.title"
        }
      }
    },
    {
      "default": 600,
      "description": "Local permission bridge timeout in seconds",
      "id": "claudeLocalPermissionBridgeTimeoutSeconds",
      "schema": {
        "kind": "positiveInteger"
      },
      "storageScope": "account",
      "ui": {
        "kind": "number",
        "numberSpec": {
          "min": 1,
          "placeholder": {
            "key": "common.default"
          },
          "step": 30
        },
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeTimeoutSeconds.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeLocalPermissionBridgeTimeoutSeconds.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": false,
      "description": "Enable Claude file checkpointing",
      "id": "claudeRemoteEnableFileCheckpointing",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteEnableFileCheckpointing.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteEnableFileCheckpointing.title"
        }
      }
    },
    {
      "default": null,
      "description": "Maximum Claude thinking tokens override",
      "id": "claudeRemoteMaxThinkingTokens",
      "schema": {
        "kind": "positiveInteger",
        "nullable": true
      },
      "storageScope": "account",
      "ui": {
        "kind": "number",
        "numberSpec": {
          "min": 1,
          "placeholder": {
            "key": "common.default"
          },
          "step": 100
        },
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteMaxThinkingTokens.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteMaxThinkingTokens.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": false,
      "description": "Disable TODO generation in Claude remote mode",
      "id": "claudeRemoteDisableTodos",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteDisableTodos.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteDisableTodos.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": false,
      "description": "Fail if Claude MCP server config is invalid",
      "id": "claudeRemoteStrictMcpServerConfig",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteStrictMcpServerConfig.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteStrictMcpServerConfig.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": false,
      "description": "Enable Claude Code debug mode (remote)",
      "id": "claudeRemoteDebugEnabled",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugEnabled.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugEnabled.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "boolean"
      },
      "default": false,
      "description": "Enable Claude Code verbose logging (remote)",
      "id": "claudeRemoteVerboseEnabled",
      "schema": {
        "kind": "boolean"
      },
      "storageScope": "account",
      "ui": {
        "kind": "boolean",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteVerboseEnabled.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteVerboseEnabled.title"
        }
      }
    },
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "serializeCurrentRule": "orderedEnumArrayJoin",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "enum"
      },
      "default": [],
      "description": "Claude Code debug categories filter (remote)",
      "id": "claudeRemoteDebugCategories",
      "schema": {
        "kind": "enumArray",
        "max": 5,
        "values": [
          "api",
          "mcp",
          "hooks",
          "file",
          "1p"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "api",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.api.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.api.title"
            }
          },
          {
            "id": "mcp",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.title"
            }
          },
          {
            "id": "hooks",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.title"
            }
          },
          {
            "id": "file",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.file.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.file.title"
            }
          },
          {
            "id": "1p",
            "subtitle": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.title"
            }
          }
        ],
        "kind": "multiEnum",
        "subtitle": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.title"
        }
      }
    }
  ],
  "id": "claude.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "orange"
      },
      "ionName": "sparkles-outline"
    },
    "sections": [
      {
        "fields": [
          "claudeRemoteAgentSdkEnabled",
          "claudeRemoteDebugEnabled",
          "claudeRemoteVerboseEnabled",
          "claudeRemoteDebugCategories",
          "claudeRemoteSettingSourcesV2",
          "claudeLocalPermissionBridgeEnabled",
          "claudeLocalPermissionBridgeWaitIndefinitely",
          "claudeLocalPermissionBridgeTimeoutSeconds",
          "claudeRemoteEnableFileCheckpointing",
          "claudeRemoteMaxThinkingTokens",
          "claudeRemoteDisableTodos",
          "claudeRemoteStrictMcpServerConfig"
        ],
        "footer": {
          "key": "settingsAgents.plugins.claude.sections.claudeRemoteSdk.footer"
        },
        "id": "claudeRemoteSdk",
        "title": {
          "key": "settingsAgents.plugins.claude.sections.claudeRemoteSdk.title"
        }
      },
      {
        "fields": [
          "claudeUnifiedTerminalEnabled",
          "claudeUnifiedTerminalHost",
          "claudeUnifiedTerminalResumeChoice"
        ],
        "footer": {
          "key": "settingsAgents.plugins.claude.sections.claudeUnifiedTerminal.footer"
        },
        "id": "claudeUnifiedTerminal",
        "title": {
          "key": "settingsAgents.plugins.claude.sections.claudeUnifiedTerminal.title"
        }
      }
    ],
    "subagentSettingsSections": [
      {
        "footer": {
          "key": "subAgentGuidance.settings.agents.claude.footer"
        },
        "id": "claudeTeams",
        "items": [
          {
            "iconIonName": "sparkles-outline",
            "id": "claudeTeamsAgentSettings",
            "route": "/(app)/settings/agents/claude",
            "subtitle": {
              "key": "subAgentGuidance.settings.agents.claude.openSubtitle"
            },
            "title": {
              "key": "subAgentGuidance.settings.agents.claude.openTitle"
            }
          }
        ],
        "title": {
          "key": "subAgentGuidance.settings.agents.claude.title"
        }
      }
    ],
    "title": {
      "key": "settingsAgents.plugins.claude.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "codex",
  "fields": [
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "enum"
      },
      "default": "appServer",
      "description": "Preferred Codex backend mode",
      "id": "codexBackendMode",
      "schema": {
        "kind": "enum",
        "values": [
          "acp",
          "appServer",
          "mcp",
          "mcp_resume"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "appServer",
            "subtitle": {
              "key": "settingsAgents.plugins.codex.fields.codexBackendMode.options.appServer.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.codex.fields.codexBackendMode.options.appServer.title"
            }
          },
          {
            "id": "acp",
            "subtitle": {
              "key": "settingsAgents.plugins.codex.fields.codexBackendMode.options.acp.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.codex.fields.codexBackendMode.options.acp.title"
            }
          }
        ],
        "kind": "enum",
        "subtitle": {
          "key": "settingsAgents.plugins.codex.fields.codexBackendMode.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.codex.fields.codexBackendMode.title"
        }
      }
    }
  ],
  "id": "codex.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "blue"
      },
      "ionName": "terminal-outline"
    },
    "sections": [
      {
        "fields": [
          "codexBackendMode"
        ],
        "footer": {
          "key": "settingsAgents.plugins.codex.sections.backendMode.footer"
        },
        "id": "codexMode",
        "title": {
          "key": "settingsAgents.plugins.codex.sections.backendMode.title"
        }
      }
    ],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.codex.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "copilot",
  "fields": [],
  "id": "copilot.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "blue"
      },
      "ionName": "logo-github"
    },
    "sections": [],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.copilot.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "kilo",
  "fields": [],
  "id": "kilo.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "orange"
      },
      "ionName": "flash-outline"
    },
    "sections": [],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.kilo.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "kimi",
  "fields": [
    {
      "analytics": {
        "identityScope": "person",
        "privacy": "safe",
        "trackChanges": true,
        "trackCurrentState": true,
        "valueKind": "enum"
      },
      "default": "auto",
      "description": "Kimi ACP Python stdio selector compatibility mode",
      "id": "kimiAcpPythonSelector",
      "schema": {
        "kind": "enum",
        "values": [
          "auto",
          "poll"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "auto",
            "subtitle": {
              "key": "settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.options.auto.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.options.auto.title"
            }
          },
          {
            "id": "poll",
            "subtitle": {
              "key": "settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.options.poll.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.options.poll.title"
            }
          }
        ],
        "kind": "enum",
        "subtitle": {
          "key": "settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.kimi.fields.kimiAcpPythonSelector.title"
        }
      }
    }
  ],
  "id": "kimi.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "green"
      },
      "ionName": "leaf-outline"
    },
    "sections": [
      {
        "fields": [
          "kimiAcpPythonSelector"
        ],
        "footer": {
          "key": "settingsAgents.plugins.kimi.sections.compatibility.footer"
        },
        "id": "kimiCompatibility",
        "title": {
          "key": "settingsAgents.plugins.kimi.sections.compatibility.title"
        }
      }
    ],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.kimi.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "kiro",
  "fields": [],
  "id": "kiro.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "orange"
      },
      "ionName": "flash-outline"
    },
    "sections": [],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.kiro.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "opencode",
  "fields": [
    {
      "default": "server",
      "description": "Preferred OpenCode backend mode",
      "id": "opencodeBackendMode",
      "schema": {
        "kind": "enum",
        "values": [
          "server",
          "acp"
        ]
      },
      "storageScope": "account",
      "ui": {
        "enumOptions": [
          {
            "id": "server",
            "subtitle": {
              "key": "settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.server.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.server.title"
            }
          },
          {
            "id": "acp",
            "subtitle": {
              "key": "settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.acp.subtitle"
            },
            "title": {
              "key": "settingsAgents.plugins.opencode.fields.opencodeBackendMode.options.acp.title"
            }
          }
        ],
        "kind": "enum",
        "subtitle": {
          "key": "settingsAgents.plugins.opencode.fields.opencodeBackendMode.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.opencode.fields.opencodeBackendMode.title"
        }
      }
    },
    {
      "default": "",
      "description": "Optional override for a user-managed OpenCode server URL",
      "id": "opencodeServerBaseUrl",
      "schema": {
        "kind": "string"
      },
      "storageScope": "account",
      "ui": {
        "binding": {
          "byServerIdSettingKey": "opencodeServerBaseUrlByServerIdV1",
          "fallbackSettingKey": "opencodeServerBaseUrl",
          "kind": "perActiveServer"
        },
        "kind": "text",
        "subtitle": {
          "key": "settingsAgents.plugins.opencode.fields.opencodeServerBaseUrl.subtitle"
        },
        "title": {
          "key": "settingsAgents.plugins.opencode.fields.opencodeServerBaseUrl.title"
        }
      }
    },
    {
      "default": {},
      "description": "Per-server overrides for user-managed OpenCode server URLs",
      "id": "opencodeServerBaseUrlByServerIdV1",
      "schema": {
        "kind": "stringRecord"
      },
      "storageScope": "account"
    }
  ],
  "id": "opencode.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "blue"
      },
      "ionName": "code-slash-outline"
    },
    "sections": [
      {
        "fields": [
          "opencodeBackendMode"
        ],
        "footer": {
          "key": "settingsAgents.plugins.opencode.sections.backendMode.footer"
        },
        "id": "opencodeBackendMode",
        "title": {
          "key": "settingsAgents.plugins.opencode.sections.backendMode.title"
        }
      },
      {
        "fields": [
          "opencodeServerBaseUrl"
        ],
        "footer": {
          "key": "settingsAgents.plugins.opencode.sections.server.footer"
        },
        "id": "opencodeServer",
        "title": {
          "key": "settingsAgents.plugins.opencode.sections.server.title"
        }
      }
    ],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.opencode.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
  Object.freeze({
  "agentId": "pi",
  "fields": [],
  "id": "pi.agentSettings.v1",
  "kind": "agentSettings.v1",
  "storageScope": "agentAccount",
  "ui": {
    "icon": {
      "color": {
        "kind": "theme",
        "token": "green"
      },
      "ionName": "code-slash-outline"
    },
    "sections": [],
    "subagentSettingsSections": [],
    "title": {
      "key": "settingsAgents.plugins.pi.title"
    }
  },
  "version": 1
} as PluginAgentSettingsContributionV1),
]);
