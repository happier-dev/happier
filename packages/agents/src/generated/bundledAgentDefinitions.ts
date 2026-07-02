/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { AgentDefinition } from '../definitions/agentDefinition.js';

type BundledAgentDefinition = AgentDefinition;

export const BUNDLED_AGENT_DEFINITION_IDS: readonly string[] = Object.freeze([
  "auggie",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "kilo",
  "kimi",
  "ohMyPi",
  "opencode",
  "pi",
  "qwen",
]);

const _BUNDLED_AGENT_DEFINITIONS_BY_ID = ({
  "auggie": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "auggie",
    "docsUrl": "https://augmentcode.com",
    "id": "auggie",
    "knownUserBinDirSuffixes": null,
    "managedInstall": {
      "binaryName": "auggie",
      "kind": "managed_package",
      "packageName": "@augmentcode/auggie"
    },
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "Auggie CLI"
  },
  "authProbeConfig": {
    "agentId": "auggie",
    "backgroundChecks": "safe",
    "binaryNames": [
      "auggie"
    ],
    "parser": "unknown",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "auggie",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "auggie",
    "flavorAliases": [],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "auggie",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "auggieSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": true
    },
    "tools": {
      "delivery": "shell_bridge",
      "support": "experimental"
    }
  },
  "id": "auggie",
  "localCli": {
    "agentId": "auggie",
    "detectKey": "auggie",
    "loginLaunch": {
      "args": [
        "login"
      ],
      "command": "auggie"
    },
    "machineLoginKey": "auggie",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "nonAcpApplyScope": "next_prompt",
    "supportsSelection": true
  },
  "providerSettings": null,
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
  "claude": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": true,
    "binaryName": "claude",
    "docsUrl": "https://claude.ai",
    "id": "claude",
    "installGuideUrl": "https://code.claude.com/docs/en/setup",
    "knownUserBinDirSuffixes": [
      ".local/bin"
    ],
    "managedInstall": null,
    "manualInstallKind": "vendor_recipe",
    "manualInstallRecipes": {
      "darwin": [
        {
          "args": [
            "-lc",
            "curl -fsSL https://claude.ai/install.sh | bash"
          ],
          "cmd": "bash"
        }
      ],
      "linux": [
        {
          "args": [
            "-lc",
            "curl -fsSL https://claude.ai/install.sh | bash"
          ],
          "cmd": "bash"
        }
      ],
      "win32": [
        {
          "args": [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://claude.ai/install.ps1 | iex"
          ],
          "cmd": "powershell"
        }
      ]
    },
    "setupRecommendation": {
      "order": 10
    },
    "sourcePreferenceDefault": "system-first",
    "title": "Claude Code CLI"
  },
  "authProbeConfig": {
    "agentId": "claude",
    "backgroundChecks": "safe",
    "binaryNames": [
      "claude"
    ],
    "credentialPaths": [
      "~/.claude/.credentials.json",
      "~/.claude/.claude.json"
    ],
    "envVars": [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN"
    ],
    "parser": "claudeCredentialsFile",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "claude",
    "cloudConnect": {
      "status": "wired",
      "vendorKey": "anthropic"
    },
    "connectedServices": {
      "providerStateSharing": {
        "config": {
          "modes": [
            "linked",
            "copied",
            "isolated"
          ],
          "supported": true
        },
        "state": {
          "modes": [
            "isolated",
            "shared"
          ],
          "sharedStatePrivacyRiskAcknowledgementRequired": true,
          "supported": true
        }
      },
      "sessionAuthSwitch": {
        "continuityMode": "restart_same_home",
        "providerStateSharingRequired": {
          "serviceIds": [
            "claude-subscription",
            "anthropic"
          ],
          "supportedTransitions": [
            "native_to_connected",
            "connected_to_native",
            "connected_to_connected"
          ]
        },
        "supportedTransitions": [
          "same_connected_group"
        ]
      },
      "supportedKindsByServiceId": {
        "anthropic": [
          "token"
        ],
        "claude-subscription": [
          "oauth",
          "token"
        ]
      },
      "supportedServiceIds": [
        "claude-subscription",
        "anthropic"
      ]
    },
    "detectKey": "claude",
    "flavorAliases": [],
    "handoff": {
      "vendorStateTransfer": "supported"
    },
    "id": "claude",
    "localControl": {
      "attachStrategy": "terminal_host",
      "supported": true,
      "topology": "exclusive"
    },
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "claudeSessionId"
    },
    "runtimeInput": {
      "inFlightSteerSupported": true,
      "terminalPromptInjectionSupported": true
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "supported",
      "sessionRollback": {
        "conversation": "unsupported"
      },
      "usageLimitRecovery": {
        "checkNow": "supported"
      }
    },
    "sessionStorage": {
      "direct": true,
      "persisted": true
    },
    "tools": {
      "delivery": "native_mcp",
      "support": "supported"
    }
  },
  "id": "claude",
  "localCli": {
    "agentId": "claude",
    "detectKey": "claude",
    "loginLaunch": {
      "args": [],
      "command": "claude",
      "initialInput": "/login\r"
    },
    "machineLoginKey": "claude-code",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "allowedModes": [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-5",
      "claude-sonnet-4-5"
    ],
    "defaultMode": "default",
    "dynamicProbe": "static-only",
    "nonAcpApplyScope": "next_prompt",
    "staticModels": [
      {
        "contextWindowTokens": 1000000,
        "description": "Newest highest-capability generally available Claude model for the hardest coding and reasoning tasks.",
        "id": "claude-fable-5",
        "modelOptions": [
          {
            "currentValue": "high",
            "id": "reasoning_effort",
            "name": "Thinking",
            "options": [
              {
                "name": "Low",
                "value": "low"
              },
              {
                "name": "Medium",
                "value": "medium"
              },
              {
                "name": "High",
                "value": "high"
              },
              {
                "name": "XHigh",
                "value": "xhigh"
              },
              {
                "name": "Max",
                "value": "max"
              }
            ],
            "type": "select"
          },
          {
            "currentValue": "false",
            "description": "Maximum coding effort. Overrides the Thinking level while enabled.",
            "id": "ultracode",
            "name": "Ultracode",
            "type": "boolean"
          }
        ],
        "name": "Fable 5"
      },
      {
        "contextWindowTokens": 1000000,
        "description": "Newest highest-capability Claude model for the hardest coding and reasoning tasks.",
        "id": "claude-opus-4-8",
        "modelOptions": [
          {
            "currentValue": "high",
            "id": "reasoning_effort",
            "name": "Thinking",
            "options": [
              {
                "name": "Low",
                "value": "low"
              },
              {
                "name": "Medium",
                "value": "medium"
              },
              {
                "name": "High",
                "value": "high"
              },
              {
                "name": "XHigh",
                "value": "xhigh"
              },
              {
                "name": "Max",
                "value": "max"
              }
            ],
            "type": "select"
          },
          {
            "currentValue": "false",
            "description": "Maximum coding effort. Overrides the Thinking level while enabled.",
            "id": "ultracode",
            "name": "Ultracode",
            "type": "boolean"
          }
        ],
        "name": "Opus 4.8"
      },
      {
        "contextWindowTokens": 1000000,
        "description": "Prior highest-capability Claude model for hard coding and reasoning tasks.",
        "id": "claude-opus-4-7",
        "modelOptions": [
          {
            "currentValue": "xhigh",
            "id": "reasoning_effort",
            "name": "Thinking",
            "options": [
              {
                "name": "Low",
                "value": "low"
              },
              {
                "name": "Medium",
                "value": "medium"
              },
              {
                "name": "High",
                "value": "high"
              },
              {
                "name": "XHigh",
                "value": "xhigh"
              },
              {
                "name": "Max",
                "value": "max"
              }
            ],
            "type": "select"
          },
          {
            "currentValue": "false",
            "description": "Maximum coding effort. Overrides the Thinking level while enabled.",
            "id": "ultracode",
            "name": "Ultracode",
            "type": "boolean"
          }
        ],
        "name": "Opus 4.7"
      },
      {
        "description": "Highest-capability Claude model for the hardest coding and reasoning tasks.",
        "extendedContextModelId": "claude-opus-4-6[1m]",
        "id": "claude-opus-4-6",
        "modelOptions": [
          {
            "currentValue": "high",
            "id": "reasoning_effort",
            "name": "Thinking",
            "options": [
              {
                "name": "Low",
                "value": "low"
              },
              {
                "name": "Medium",
                "value": "medium"
              },
              {
                "name": "High",
                "value": "high"
              },
              {
                "name": "Max",
                "value": "max"
              }
            ],
            "type": "select"
          }
        ],
        "name": "Opus 4.6"
      },
      {
        "description": "Balanced Claude model for everyday coding, editing, and analysis.",
        "extendedContextModelId": "claude-sonnet-4-6[1m]",
        "id": "claude-sonnet-4-6",
        "modelOptions": [
          {
            "currentValue": "high",
            "id": "reasoning_effort",
            "name": "Thinking",
            "options": [
              {
                "name": "Low",
                "value": "low"
              },
              {
                "name": "Medium",
                "value": "medium"
              },
              {
                "name": "High",
                "value": "high"
              }
            ],
            "type": "select"
          }
        ],
        "name": "Sonnet 4.6"
      },
      {
        "description": "Fastest Claude option for lighter tasks and lower-latency replies.",
        "id": "claude-haiku-4-5",
        "name": "Haiku 4.5"
      },
      {
        "description": "Prior Opus generation alias for compatibility with existing Claude setups.",
        "id": "claude-opus-4-5",
        "modelOptions": [
          {
            "currentValue": "high",
            "id": "reasoning_effort",
            "name": "Thinking",
            "options": [
              {
                "name": "Low",
                "value": "low"
              },
              {
                "name": "Medium",
                "value": "medium"
              },
              {
                "name": "High",
                "value": "high"
              }
            ],
            "type": "select"
          }
        ],
        "name": "Opus 4.5"
      },
      {
        "description": "Prior Sonnet generation alias for compatibility with existing Claude setups.",
        "id": "claude-sonnet-4-5",
        "name": "Sonnet 4.5"
      }
    ],
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "providerSettings": null,
  "runtimeContributions": {
    "protocolBuiltInBackendProfiles": {
      "exportName": "CLAUDE_BUILT_IN_BACKEND_PROFILES",
      "kind": "providerBuiltInBackendProfilesV1",
      "providerId": "claude",
      "source": "./protocol/profiles"
    },
    "protocolExternalSessionSource": {
      "exportName": "CLAUDE_EXTERNAL_SESSION_SOURCE",
      "kind": "providerExternalSessionSourceV1",
      "providerId": "claude",
      "source": "./protocol/externalSession"
    },
    "protocolMemoryDefaults": {
      "exportName": "CLAUDE_MEMORY_DEFAULTS",
      "kind": "providerMemoryDefaultsV1",
      "providerId": "claude",
      "source": "./protocol/memory"
    },
    "providerCatalogEntry": {
      "importName": "CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "provider-native",
    "semantics": "agent-modes",
    "source": "provider-native"
  },
  "sessionModesKind": "staticAgentModes"
}) as const),
  "codex": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "codex",
    "id": "codex",
    "managedInstall": null,
    "manualInstallKind": "none",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "codex CLI"
  },
  "authProbeConfig": {
    "agentId": "codex",
    "backgroundChecks": "safe",
    "binaryNames": [
      "codex"
    ],
    "parser": "unknown",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "codex",
    "detectKey": "codex",
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "codex",
    "resume": {
      "vendorResume": "unsupported",
      "vendorResumeIdField": null
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": false
    },
    "tools": {
      "delivery": "unsupported",
      "support": "unsupported"
    }
  },
  "id": "codex",
  "localCli": {
    "agentId": "codex",
    "detectKey": "codex",
    "loginLaunch": null,
    "machineLoginKey": "codex",
    "supportKind": "unsupported"
  },
  "modelConfig": {
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "nonAcpApplyScope": "spawn_only",
    "supportsSelection": false
  },
  "providerSettings": null,
  "runtimeContributions": {
    "externalSessionHostAdapters": {
      "candidateHostAdapter": {
        "exportName": "createCodexExternalSessionCandidateHostAdapter",
        "source": "@/backends/codex/appServer/session/externalCandidates"
      },
      "kind": "providerExternalSessionHostAdaptersV1",
      "providerId": "codex",
      "transcriptStoreAdapter": {
        "exportName": "createCodexExternalSessionTranscriptStoreAdapter",
        "source": "@/backends/codex/rollout/sessionStore/externalTranscriptAdapter"
      }
    },
    "protocolBuiltInBackendProfiles": {
      "exportName": "CODEX_BUILT_IN_BACKEND_PROFILES",
      "kind": "providerBuiltInBackendProfilesV1",
      "providerId": "codex",
      "source": "./protocol/profiles"
    },
    "protocolExternalSessionSource": {
      "exportName": "CODEX_EXTERNAL_SESSION_SOURCE",
      "kind": "providerExternalSessionSourceV1",
      "providerId": "codex",
      "source": "./protocol/externalSession"
    },
    "protocolRuntimeDescriptor": {
      "buildFunction": "buildCodexAgentRuntimeDescriptorV1",
      "canonicalReader": "readCanonicalCodexAgentRuntimeDescriptorV1",
      "kind": "providerRuntimeDescriptorV1",
      "providerId": "codex",
      "source": "./protocol/runtimeDescriptorV1"
    },
    "providerCatalogEntry": {
      "importName": "CODEX_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    },
    "runtimeDescriptorReader": {
      "exportName": "readCodexSessionMetadataRuntimeDescriptor",
      "kind": "providerRuntimeDescriptorReader",
      "providerId": "codex",
      "source": "./agent/identity/runtimeDescriptor"
    },
    "sessionControlAdapter": {
      "exportName": "CODEX_SESSION_CONTROL_ADAPTER",
      "kind": "providerSessionControlAdapter",
      "providerId": "codex",
      "source": "./agent/surfaces/sessions/controls/adapter"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
  "copilot": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "copilot",
    "docsUrl": "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    "id": "copilot",
    "installGuideUrl": null,
    "knownUserBinDirSuffixes": null,
    "managedInstall": {
      "binaryName": "copilot",
      "kind": "managed_package",
      "packageName": "@github/copilot"
    },
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "GitHub Copilot CLI"
  },
  "authProbeConfig": {
    "agentId": "copilot",
    "backgroundChecks": "safe",
    "binaryNames": [
      "copilot"
    ],
    "envVars": [
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN"
    ],
    "parser": "copilotGhAuth",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "copilot",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "copilot",
    "flavorAliases": [
      "github-copilot",
      "copilot-cli"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "copilot",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "copilotSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": true
    },
    "tools": {
      "delivery": "shell_bridge",
      "support": "experimental"
    }
  },
  "id": "copilot",
  "localCli": {
    "agentId": "copilot",
    "detectKey": "copilot",
    "loginLaunch": {
      "args": [
        "login"
      ],
      "command": "copilot"
    },
    "machineLoginKey": "copilot",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "nonAcpApplyScope": "next_prompt",
    "supportsSelection": true
  },
  "providerSettings": null,
  "runtimeContributions": {
    "providerCatalogEntry": {
      "importName": "COPILOT_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "acp-setSessionMode",
    "semantics": "agent-modes",
    "source": "acp"
  },
  "sessionModesKind": "acpAgentModes"
}) as const),
  "cursor": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "cursor-agent",
    "docsUrl": "https://cursor.com/docs/cli",
    "id": "cursor",
    "installGuideUrl": "https://cursor.com/docs/cli/installation",
    "knownUserBinDirSuffixes": [
      ".local/bin"
    ],
    "managedInstall": null,
    "manualInstallKind": "vendor_recipe",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "Cursor Agent CLI"
  },
  "authProbeConfig": {
    "agentId": "cursor",
    "backgroundChecks": "safe",
    "binaryNames": [
      "cursor-agent",
      "agent"
    ],
    "envVars": [
      "CURSOR_API_KEY"
    ],
    "parser": "cursorAboutJson",
    "statusCommand": [
      "about",
      "--format",
      "json"
    ]
  },
  "core": {
    "cliSubcommand": "cursor",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "cursor-agent",
    "flavorAliases": [
      "cursor-agent"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "cursor",
    "localControl": {
      "attachStrategy": "unsupported",
      "supported": true,
      "topology": "exclusive"
    },
    "resume": {
      "experimentalResumePolicy": "runtime_checked",
      "vendorResume": "experimental",
      "vendorResumeIdField": "cursorSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      }
    },
    "sessionStorage": {
      "direct": true,
      "persisted": true
    },
    "tools": {
      "delivery": "shell_bridge",
      "support": "experimental"
    }
  },
  "id": "cursor",
  "localCli": {
    "agentId": "cursor",
    "detectKey": "cursor-agent",
    "loginLaunch": null,
    "machineLoginKey": "cursor-agent",
    "supportKind": "status_only"
  },
  "modelConfig": {
    "acpApplyBehavior": "set_model",
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "composer-2.5-fast"
    ],
    "defaultMode": "composer-2.5-fast",
    "dynamicProbe": "auto",
    "nonAcpApplyScope": "next_prompt",
    "staticModels": [
      {
        "description": "Cursor Composer 2.5 fast model, discovered dynamically when the Cursor CLI is available.",
        "id": "composer-2.5-fast",
        "name": "Composer 2.5 Fast"
      }
    ],
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "providerSettings": null,
  "sessionModeDescriptor": {
    "runtimeSwitch": "acp-setSessionMode",
    "semantics": "agent-modes",
    "source": "acp"
  },
  "sessionModesKind": "acpAgentModes"
}) as const),
  "gemini": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "gemini",
    "docsUrl": "https://goo.gle/gemini-cli-auth-docs",
    "id": "gemini",
    "installGuideUrl": null,
    "knownUserBinDirSuffixes": null,
    "managedInstall": {
      "binaryName": "gemini",
      "kind": "managed_package",
      "packageName": "@google/gemini-cli"
    },
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "Google Gemini CLI"
  },
  "authProbeConfig": {
    "agentId": "gemini",
    "backgroundChecks": "safe",
    "binaryNames": [
      "gemini"
    ],
    "credentialPaths": [
      "~/.gemini/oauth_creds.json",
      "~/.gemini/config.json",
      "~/.config/gemini/config.json",
      "~/.gemini/auth.json",
      "~/.config/gemini/auth.json",
      "~/.config/gcloud/application_default_credentials.json"
    ],
    "envVars": [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY"
    ],
    "parser": "geminiCredentialFiles",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "gemini",
    "cloudConnect": {
      "status": "wired",
      "vendorKey": "gemini"
    },
    "connectedServices": {
      "sessionAuthSwitch": {
        "continuityMode": "restart_same_home",
        "supportedTransitions": [
          "native_to_connected",
          "connected_to_connected"
        ]
      },
      "supportedKindsByServiceId": {
        "gemini": [
          "oauth"
        ]
      },
      "supportedServiceIds": [
        "gemini"
      ]
    },
    "detectKey": "gemini",
    "flavorAliases": [],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "gemini",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "geminiSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      },
      "usageLimitRecovery": {
        "checkNow": "supported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": true
    },
    "tools": {
      "delivery": "native_mcp",
      "support": "supported"
    }
  },
  "id": "gemini",
  "localCli": {
    "agentId": "gemini",
    "detectKey": "gemini",
    "loginLaunch": {
      "args": [
        "auth"
      ],
      "command": "gemini"
    },
    "machineLoginKey": "gemini-cli",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpApplyBehavior": "restart_session",
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview"
    ],
    "defaultMode": "gemini-2.5-pro",
    "nonAcpApplyScope": "next_prompt",
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "providerSettings": null,
  "runtimeContributions": {
    "protocolBuiltInBackendProfiles": {
      "exportName": "GEMINI_BUILT_IN_BACKEND_PROFILES",
      "kind": "providerBuiltInBackendProfilesV1",
      "providerId": "gemini",
      "source": "./protocol/profiles"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
  "kilo": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "kilo",
    "docsUrl": "https://kilo.ai/docs/cli",
    "id": "kilo",
    "installGuideUrl": null,
    "knownUserBinDirSuffixes": null,
    "managedInstall": {
      "binaryName": "kilo",
      "kind": "managed_package",
      "packageName": "@kilocode/cli"
    },
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "Kilo CLI"
  },
  "authProbeConfig": {
    "agentId": "kilo",
    "backgroundChecks": "safe",
    "binaryNames": [
      "kilo"
    ],
    "parser": "unknown",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "kilo",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "kilo",
    "flavorAliases": [
      "kilocode"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "kilo",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "kiloSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": true
    },
    "tools": {
      "delivery": "shell_bridge",
      "support": "experimental"
    }
  },
  "id": "kilo",
  "localCli": {
    "agentId": "kilo",
    "detectKey": "kilo",
    "loginLaunch": {
      "args": [],
      "command": "kilo",
      "initialInput": "/connect\r"
    },
    "machineLoginKey": "kilo",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "nonAcpApplyScope": "next_prompt",
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "providerSettings": null,
  "runtimeContributions": {
    "providerCatalogEntry": {
      "importName": "KILO_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "acp-setSessionMode",
    "semantics": "agent-modes",
    "source": "acp"
  },
  "sessionModesKind": "acpAgentModes"
}) as const),
  "kimi": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "kimi",
    "docsUrl": "https://code.kimi.com",
    "id": "kimi",
    "installGuideUrl": "https://kimi.moonshot.cn/docs/cli",
    "knownUserBinDirSuffixes": [
      ".local/bin"
    ],
    "managedInstall": null,
    "manualInstallKind": "vendor_recipe",
    "manualInstallRecipes": {
      "darwin": [
        {
          "args": [
            "-lc",
            "curl -fsSL https://code.kimi.com/install.sh | bash"
          ],
          "cmd": "bash"
        }
      ],
      "linux": [
        {
          "args": [
            "-lc",
            "curl -fsSL https://code.kimi.com/install.sh | bash"
          ],
          "cmd": "bash"
        }
      ],
      "win32": [
        {
          "args": [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression"
          ],
          "cmd": "powershell"
        }
      ]
    },
    "sourcePreferenceDefault": "system-first",
    "title": "Kimi CLI"
  },
  "authProbeConfig": {
    "agentId": "kimi",
    "backgroundChecks": "safe",
    "binaryNames": [
      "kimi"
    ],
    "parser": "unknown",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "kimi",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "kimi",
    "flavorAliases": [
      "kimi-cli"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "kimi",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "kimiSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": true
    },
    "tools": {
      "delivery": "shell_bridge",
      "support": "experimental"
    }
  },
  "id": "kimi",
  "localCli": {
    "agentId": "kimi",
    "detectKey": "kimi",
    "loginLaunch": {
      "args": [
        "login"
      ],
      "command": "kimi"
    },
    "machineLoginKey": "kimi",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "dynamicProbe": "auto",
    "nonAcpApplyScope": "next_prompt",
    "supportsSelection": true
  },
  "providerSettings": null,
  "runtimeContributions": {
    "providerCatalogEntry": {
      "importName": "KIMI_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
  "ohMyPi": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": true,
    "binaryName": "omp",
    "docsUrl": "https://github.com/can1357/oh-my-pi",
    "id": "ohMyPi",
    "installGuideUrl": "https://github.com/can1357/oh-my-pi#via-bun-recommended",
    "knownUserBinDirSuffixes": [
      ".bun/bin"
    ],
    "managedInstall": {
      "binaryName": "omp",
      "githubRepo": "can1357/oh-my-pi",
      "kind": "github_release_binary"
    },
    "manualInstallKind": "vendor_recipe",
    "manualInstallRecipes": {
      "darwin": [
        {
          "args": [
            "install",
            "-g",
            "@oh-my-pi/pi-coding-agent"
          ],
          "cmd": "bun"
        }
      ],
      "linux": [
        {
          "args": [
            "install",
            "-g",
            "@oh-my-pi/pi-coding-agent"
          ],
          "cmd": "bun"
        }
      ],
      "win32": [
        {
          "args": [
            "install",
            "-g",
            "@oh-my-pi/pi-coding-agent"
          ],
          "cmd": "bun"
        }
      ]
    },
    "sourcePreferenceDefault": "system-first",
    "title": "oh-my-pi CLI"
  },
  "authProbeConfig": {
    "agentId": "ohMyPi",
    "backgroundChecks": "safe",
    "binaryNames": [
      "omp"
    ],
    "envVars": [
      "OPENAI_CODEX_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY"
    ],
    "parser": "piEnvOnly",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "ohMyPi",
    "cloudConnect": null,
    "connectedServices": {
      "supportedKindsByServiceId": {
        "anthropic": [
          "token"
        ],
        "claude-subscription": [
          "token"
        ],
        "gemini": [
          "oauth",
          "token"
        ],
        "openai": [
          "token"
        ],
        "openai-codex": [
          "oauth"
        ]
      },
      "supportedServiceIds": [
        "openai-codex",
        "openai",
        "claude-subscription",
        "anthropic",
        "gemini"
      ]
    },
    "detectKey": "omp",
    "flavorAliases": [
      "oh-my-pi",
      "omp"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "ohMyPi",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "ohMyPiSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "supported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "supported",
      "sessionRollback": {
        "conversation": "unsupported"
      }
    },
    "sessionStorage": {
      "direct": true,
      "persisted": true
    },
    "tools": {
      "delivery": "native_mcp",
      "support": "supported"
    }
  },
  "id": "ohMyPi",
  "localCli": {
    "agentId": "ohMyPi",
    "detectKey": "omp",
    "loginLaunch": null,
    "machineLoginKey": "oh-my-pi",
    "supportKind": "manual_only"
  },
  "modelConfig": {
    "acpApplyBehavior": "set_model",
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "dynamicProbe": "auto",
    "nonAcpApplyScope": "next_prompt",
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "providerSettings": null,
  "runtimeContributions": {
    "protocolExternalSessionSource": {
      "exportName": "OH_MY_PI_EXTERNAL_SESSION_SOURCE",
      "kind": "providerExternalSessionSourceV1",
      "providerId": "ohMyPi",
      "source": "./protocol/externalSession"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "acp-setSessionMode",
    "semantics": "agent-modes",
    "source": "acp"
  },
  "sessionModesKind": "acpAgentModes"
}) as const),
  "opencode": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "opencode",
    "docsUrl": "https://opencode.ai",
    "id": "opencode",
    "installGuideUrl": "https://opencode.ai/docs",
    "knownUserBinDirSuffixes": [
      ".opencode/bin",
      "AppData/Roaming/npm"
    ],
    "managedInstall": null,
    "manualInstallKind": "vendor_recipe",
    "manualInstallRecipes": {
      "darwin": [
        {
          "args": [
            "-lc",
            "curl -fsSL https://opencode.ai/install | bash"
          ],
          "cmd": "bash"
        }
      ],
      "linux": [
        {
          "args": [
            "-lc",
            "curl -fsSL https://opencode.ai/install | bash"
          ],
          "cmd": "bash"
        }
      ],
      "win32": [
        {
          "args": [
            "/c",
            "npm install -g opencode-ai"
          ],
          "cmd": "cmd.exe",
          "note": null
        }
      ]
    },
    "setupRecommendation": {
      "order": 40
    },
    "sourcePreferenceDefault": "system-first",
    "title": "OpenCode CLI"
  },
  "authProbeConfig": {
    "agentId": "opencode",
    "backgroundChecks": "safe",
    "binaryNames": [
      "opencode"
    ],
    "parser": "opencodeAuthList",
    "statusCommand": [
      "auth",
      "list"
    ]
  },
  "commandSurface": {
    "allowTmux": true,
    "rootHelpDescription": "Start OpenCode CLI",
    "rootHelpLabel": "happier opencode"
  },
  "core": {
    "cliSubcommand": "opencode",
    "cloudConnect": null,
    "connectedServices": {
      "sessionAuthSwitch": {
        "continuityMode": "restart_same_home",
        "supportedTransitions": [
          "native_to_connected",
          "connected_to_native",
          "connected_to_connected"
        ]
      },
      "supportedKindsByServiceId": {
        "anthropic": [
          "token"
        ],
        "claude-subscription": [
          "token"
        ],
        "openai": [
          "token"
        ],
        "openai-codex": [
          "oauth"
        ]
      },
      "supportedServiceIds": [
        "openai-codex",
        "openai",
        "claude-subscription",
        "anthropic"
      ]
    },
    "detectKey": "opencode",
    "flavorAliases": [
      "open-code"
    ],
    "handoff": {
      "vendorStateTransfer": "supported"
    },
    "id": "opencode",
    "localControl": {
      "attachStrategy": "provider_attach",
      "remoteWritable": true,
      "supported": true,
      "topology": "shared"
    },
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "opencodeSessionId"
    },
    "runtimeKinds": {
      "byKind": {
        "acp": {
          "kind": "acp",
          "overrides": {
            "localControl": null,
            "sessionCapabilities": {
              "sessionFork": {
                "fromMessage": "unsupported"
              },
              "usageLimitRecovery": {
                "checkNow": "unsupported"
              }
            },
            "sessionStorage": {
              "direct": false
            }
          }
        },
        "server": {
          "kind": "server"
        }
      },
      "defaultKind": "server"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "supported",
        "fromMessage": "supported"
      },
      "sessionListing": "supported",
      "sessionRollback": {
        "conversation": "unsupported"
      },
      "usageLimitRecovery": {
        "checkNow": "supported"
      }
    },
    "sessionStorage": {
      "direct": true,
      "persisted": true
    },
    "tools": {
      "delivery": "native_mcp",
      "support": "supported"
    }
  },
  "id": "opencode",
  "localCli": {
    "agentId": "opencode",
    "detectKey": "opencode",
    "loginLaunch": {
      "args": [
        "auth",
        "login"
      ],
      "command": "opencode"
    },
    "machineLoginKey": "opencode",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "nonAcpApplyScope": "next_prompt",
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "providerSettings": null,
  "runtimeContributions": {
    "protocolExternalSessionSource": {
      "exportName": "OPENCODE_EXTERNAL_SESSION_SOURCE",
      "kind": "providerExternalSessionSourceV1",
      "providerId": "opencode",
      "source": "./protocol/externalSession"
    },
    "protocolRuntimeDescriptor": {
      "buildFunction": "buildOpenCodeAgentRuntimeDescriptorV1",
      "canonicalReader": "readCanonicalOpenCodeAgentRuntimeDescriptorV1",
      "kind": "providerRuntimeDescriptorV1",
      "providerId": "opencode",
      "source": "./protocol/runtimeDescriptorV1"
    },
    "providerCatalogEntry": {
      "importName": "OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    },
    "runtimeDescriptorReader": {
      "exportName": "readOpenCodeSessionMetadataRuntimeDescriptor",
      "kind": "providerRuntimeDescriptorReader",
      "providerId": "opencode",
      "source": "./agent/identity/runtimeDescriptor"
    },
    "sessionControlAdapter": {
      "exportName": "OPENCODE_SESSION_CONTROL_ADAPTER",
      "kind": "providerSessionControlAdapter",
      "providerId": "opencode",
      "source": "./agent/surfaces/sessions/controls/adapter"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "acp-setSessionMode",
    "semantics": "agent-modes",
    "source": "acp"
  },
  "sessionModesKind": "acpAgentModes"
}) as const),
  "pi": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "pi",
    "docsUrl": null,
    "id": "pi",
    "installGuideUrl": "https://github.com/badlogic/pi-mono",
    "knownUserBinDirSuffixes": null,
    "managedInstall": {
      "binaryName": "pi",
      "kind": "managed_package",
      "packageName": "@earendil-works/pi-coding-agent"
    },
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "Pi Coding Agent CLI"
  },
  "authProbeConfig": {
    "agentId": "pi",
    "backgroundChecks": "safe",
    "binaryNames": [
      "pi"
    ],
    "envVars": [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY"
    ],
    "parser": "piEnvOnly",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "pi",
    "cloudConnect": null,
    "connectedServices": {
      "providerStateSharing": {
        "config": {
          "modes": [
            "isolated"
          ],
          "supported": false,
          "unavailableReason": "not_implemented"
        },
        "state": {
          "modes": [
            "isolated",
            "shared"
          ],
          "sharedStatePrivacyRiskAcknowledgementRequired": true,
          "supported": true
        }
      },
      "sessionAuthSwitch": {
        "continuityMode": "restart_same_home",
        "providerStateSharingRequired": {
          "supportedTransitions": [
            "native_to_connected",
            "connected_to_native",
            "connected_to_connected"
          ]
        },
        "supportedTransitions": [
          "connected_to_connected"
        ]
      },
      "supportedKindsByServiceId": {
        "anthropic": [
          "token"
        ],
        "claude-subscription": [
          "token"
        ],
        "openai": [
          "token"
        ],
        "openai-codex": [
          "oauth"
        ]
      },
      "supportedServiceIds": [
        "openai-codex",
        "openai",
        "claude-subscription",
        "anthropic"
      ]
    },
    "detectKey": "pi",
    "flavorAliases": [
      "pi-coding-agent"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "pi",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "piSessionId"
    },
    "runtimeInput": {
      "inFlightSteerSupported": true,
      "terminalPromptInjectionSupported": false
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      },
      "usageLimitRecovery": {
        "checkNow": "supported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": true
    },
    "tools": {
      "delivery": "shell_bridge",
      "support": "experimental"
    }
  },
  "id": "pi",
  "localCli": {
    "agentId": "pi",
    "detectKey": "pi",
    "loginLaunch": null,
    "machineLoginKey": "pi",
    "supportKind": "status_only"
  },
  "modelConfig": {
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "dynamicProbe": "auto",
    "nonAcpApplyScope": "next_prompt",
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "providerSettings": null,
  "runtimeContributions": {
    "protocolRuntimeDescriptor": {
      "buildFunction": "buildPiAgentRuntimeDescriptorV1",
      "canonicalReader": "readCanonicalPiAgentRuntimeDescriptorV1",
      "kind": "providerRuntimeDescriptorV1",
      "providerId": "pi",
      "source": "./protocol/runtimeDescriptorV1"
    },
    "providerCatalogEntry": {
      "importName": "PI_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    },
    "runtimeDescriptorReader": {
      "kind": "providerSessionId",
      "providerId": "pi",
      "runtimeHandle": "providerSessionId"
    },
    "sessionControlAdapter": {
      "absolutePathField": "sessionFile",
      "fallbackField": "providerSessionId",
      "kind": "runtimeDescriptorResumeId",
      "providerId": "pi"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
  "qwen": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "qwen",
    "docsUrl": null,
    "id": "qwen",
    "installGuideUrl": "https://qwenlm.github.io/qwen-code-docs/",
    "knownUserBinDirSuffixes": null,
    "managedInstall": {
      "binaryName": "qwen",
      "kind": "managed_package",
      "packageName": "@qwen-code/qwen-code"
    },
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "Qwen CLI"
  },
  "authProbeConfig": {
    "agentId": "qwen",
    "backgroundChecks": "safe",
    "binaryNames": [
      "qwen"
    ],
    "parser": "unknown",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "qwen",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "qwen",
    "flavorAliases": [
      "qwen-code"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "qwen",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "qwenSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "unsupported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": true
    },
    "tools": {
      "delivery": "shell_bridge",
      "support": "experimental"
    }
  },
  "id": "qwen",
  "localCli": {
    "agentId": "qwen",
    "detectKey": "qwen",
    "loginLaunch": {
      "args": [],
      "command": "qwen",
      "initialInput": "/auth\r"
    },
    "machineLoginKey": "qwen",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "dynamicProbe": "static-only",
    "nonAcpApplyScope": "next_prompt",
    "supportsSelection": true
  },
  "providerSettings": null,
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
}) as const satisfies Readonly<Record<string, BundledAgentDefinition>>;

export const BUNDLED_AGENT_DEFINITIONS_BY_ID = Object.freeze(_BUNDLED_AGENT_DEFINITIONS_BY_ID);

// Canonical generated aggregate exports (avoid "*families*" naming).
export const bundledAgentDefinitionIds = BUNDLED_AGENT_DEFINITION_IDS;
export const bundledAgentDefinitions = BUNDLED_AGENT_DEFINITIONS_BY_ID;
