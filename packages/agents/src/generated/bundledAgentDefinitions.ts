/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { AgentDefinition } from '../definitions/agentDefinition.js';

type BundledAgentDefinition = AgentDefinition;

export const BUNDLED_AGENT_DEFINITION_IDS: readonly string[] = Object.freeze([
  "antigravity",
  "auggie",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "kilo",
  "kimi",
  "kiro",
  "ohMyPi",
  "opencode",
  "pi",
  "qwen",
  "coderabbit",
  "deepsec",
]);

const _BUNDLED_AGENT_DEFINITIONS_BY_ID = ({
  "antigravity": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "agy",
    "docsUrl": "https://antigravity.google/docs/cli-install",
    "id": "antigravity",
    "installGuideUrl": "https://antigravity.google/docs/cli-install",
    "knownUserBinDirSuffixes": null,
    "managedInstall": null,
    "manualInstallKind": "vendor_recipe",
    "manualInstallRecipes": {
      "darwin": [
        {
          "args": [
            "-lc",
            "curl -fsSL https://antigravity.google/cli/install.sh | bash"
          ],
          "cmd": "bash"
        }
      ],
      "linux": [
        {
          "args": [
            "-lc",
            "curl -fsSL https://antigravity.google/cli/install.sh | bash"
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
            "irm https://antigravity.google/cli/install.ps1 | iex"
          ],
          "cmd": "powershell"
        }
      ]
    },
    "sourcePreferenceDefault": "system-first",
    "title": "Antigravity CLI"
  },
  "agentSettings": null,
  "authProbeConfig": {
    "agentId": "antigravity",
    "backgroundChecks": "manual_only",
    "binaryNames": [
      "agy"
    ],
    "parser": "none",
    "statusCommand": null
  },
  "core": {
    "backendDefinition": false,
    "cliSubcommand": "antigravity",
    "cloudConnect": null,
    "connectedServices": {
      "supportedKindsByServiceId": {
        "gemini": [
          "token"
        ]
      },
      "supportedServiceIds": [
        "gemini"
      ]
    },
    "detectKey": "agy",
    "flavorAliases": [
      "agy"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "antigravity",
    "localControl": {
      "attachStrategy": "terminal_host",
      "supported": true,
      "topology": "exclusive"
    },
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
      "persisted": true
    },
    "tools": {
      "delivery": "unsupported",
      "support": "unsupported"
    }
  },
  "enablementCompatibilityBackendIds": [
    "antigravity-localharness",
    "antigravity-terminal"
  ],
  "id": "antigravity",
  "localCli": {
    "agentId": "antigravity",
    "detectKey": "agy",
    "loginLaunch": {
      "args": [],
      "command": "agy"
    },
    "machineLoginKey": "antigravity-cli",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpApplyBehavior": "restart_session",
    "acpModelConfigOptionId": null,
    "allowedModes": [
      "Gemini 3.5 Flash (Medium)"
    ],
    "defaultMode": "Gemini 3.5 Flash (Medium)",
    "dynamicProbe": "auto",
    "nonAcpApplyScope": "next_prompt",
    "staticModels": [
      {
        "description": "Observed Antigravity CLI model fallback. The full list is discovered dynamically with agy models.",
        "id": "Gemini 3.5 Flash (Medium)",
        "name": "Gemini 3.5 Flash (Medium)"
      }
    ],
    "supportsFreeform": false,
    "supportsSelection": true
  },
  "ownedBackendIds": [
    "antigravity"
  ],
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "ANTIGRAVITY_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none",
  "settingsBackendId": "antigravity"
}) as const),
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
  "agentSettings": null,
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
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "AUGGIE_PROVIDER_RUNTIME_CONTRIBUTION",
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
    "systemCommandResolutionStrategy": "known-user-first-runnable",
    "title": "Claude Code CLI"
  },
  "agentSettings": null,
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
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    },
    "protocolBuiltInBackendProfiles": {
      "exportName": "CLAUDE_BUILT_IN_BACKEND_PROFILES",
      "kind": "providerBuiltInBackendProfilesV1",
      "providerId": "claude",
      "source": "./protocol/profiles"
    },
    "protocolMemoryDefaults": {
      "exportName": "CLAUDE_MEMORY_DEFAULTS",
      "kind": "providerMemoryDefaultsV1",
      "providerId": "claude",
      "source": "./protocol/memory"
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
    "docsUrl": "https://github.com/openai/codex",
    "id": "codex",
    "installGuideUrl": null,
    "knownUserBinDirSuffixes": null,
    "managedInstall": {
      "binaryName": "codex",
      "githubRepo": "openai/codex",
      "kind": "github_release_binary"
    },
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "setupRecommendation": {
      "order": 20
    },
    "sourcePreferenceDefault": "system-first",
    "title": "OpenAI Codex CLI"
  },
  "agentSettings": null,
  "authProbeConfig": {
    "agentId": "codex",
    "backgroundChecks": "safe",
    "binaryNames": [
      "codex"
    ],
    "credentialPaths": [
      "~/.codex/auth.json"
    ],
    "envVars": [
      "OPENAI_API_KEY",
      "CODEX_API_KEY"
    ],
    "parser": "codexLoginStatus",
    "statusCommand": [
      "login",
      "status"
    ]
  },
  "commandPolicy": {
    "daemonAutostartDefault": "preferLocalTui"
  },
  "core": {
    "cliSubcommand": "codex",
    "cloudConnect": {
      "status": "wired",
      "vendorKey": "openai"
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
        "continuityMode": "restart_shared_state_required",
        "providerStateSharingRequired": {
          "serviceIds": [
            "openai-codex"
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
        "openai": [
          "token"
        ],
        "openai-codex": [
          "oauth"
        ]
      },
      "supportedServiceIds": [
        "openai-codex",
        "openai"
      ]
    },
    "detectKey": "codex",
    "flavorAliases": [
      "codex-acp",
      "codex-mcp",
      "openai",
      "gpt"
    ],
    "handoff": {
      "requiresExplicitSessionId": true,
      "vendorStateTransfer": "experimental"
    },
    "id": "codex",
    "localControl": {
      "attachStrategy": "terminal_host",
      "supported": true,
      "topology": "exclusive"
    },
    "resume": {
      "vendorResume": "experimental",
      "vendorResumeIdField": "codexSessionId"
    },
    "runtimeKinds": {
      "byKind": {
        "acp": {
          "kind": "acp",
          "overrides": {
            "sessionCapabilities": {
              "sessionFork": {
                "conversation": "unsupported"
              },
              "sessionRollback": {
                "conversation": "unsupported"
              },
              "usageLimitRecovery": {
                "checkNow": "unsupported"
              }
            }
          }
        },
        "appServer": {
          "kind": "appServer"
        },
        "mcp": {
          "kind": "mcp",
          "overrides": {
            "handoff": {
              "vendorStateTransfer": "unsupported"
            },
            "localControl": null,
            "resume": {
              "vendorResume": "unsupported"
            },
            "sessionCapabilities": {
              "sessionFork": {
                "conversation": "unsupported"
              },
              "sessionRollback": {
                "conversation": "unsupported"
              },
              "usageLimitRecovery": {
                "checkNow": "unsupported"
              }
            }
          }
        }
      },
      "defaultKind": "appServer"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "supported",
        "fromMessage": "unsupported"
      },
      "sessionListing": "supported",
      "sessionRollback": {
        "conversation": "supported"
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
  "id": "codex",
  "localCli": {
    "agentId": "codex",
    "detectKey": "codex",
    "loginLaunch": {
      "args": [
        "login"
      ],
      "command": "codex"
    },
    "machineLoginKey": "codex",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "dynamicProbe": "auto",
    "nonAcpApplyScope": "spawn_only",
    "supportsSelection": true
  },
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "CODEX_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    },
    "protocolBuiltInBackendProfiles": {
      "exportName": "CODEX_BUILT_IN_BACKEND_PROFILES",
      "kind": "providerBuiltInBackendProfilesV1",
      "providerId": "codex",
      "source": "./protocol/profiles"
    },
    "protocolRuntimeDescriptor": {
      "buildFunction": "buildCodexAgentRuntimeDescriptorV1",
      "canonicalReader": "readCanonicalCodexAgentRuntimeDescriptorV1",
      "kind": "providerRuntimeDescriptorV1",
      "providerId": "codex",
      "source": "./protocol/runtimeDescriptorV1"
    },
    "runtimeDescriptorReader": {
      "exportName": "readCodexSessionMetadataRuntimeDescriptor",
      "generatedReader": {
        "backendModeKey": "backendMode",
        "fields": [
          {
            "key": "backendMode",
            "kind": "runtimeKind",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "providerSessionId",
            "kind": "trimmedString",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "home",
            "kind": "trimmedString",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "connectedServiceId",
            "kind": "trimmedString",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "connectedServiceProfileId",
            "kind": "trimmedString",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "connectedServiceGroupId",
            "kind": "trimmedString",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "homePath",
            "kind": "trimmedString",
            "runtimeHandle": "whenPresent"
          }
        ],
        "legacy": {
          "fields": [
            {
              "key": "backendMode",
              "kind": "runtimeKind",
              "runtimeHandle": "whenPresent",
              "sourceKey": "codexBackendMode"
            },
            {
              "key": "providerSessionId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent",
              "sourceKey": "codexSessionId"
            },
            {
              "key": "home",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "connectedServiceId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "connectedServiceProfileId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "connectedServiceGroupId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "homePath",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            }
          ],
          "requireRuntimeKind": true
        },
        "providerId": "codex",
        "runtimeKind": {
          "aliases": [
            {
              "input": "acp",
              "runtimeKind": "acp"
            },
            {
              "input": "appServer",
              "runtimeKind": "appServer"
            },
            {
              "input": "mcp",
              "runtimeKind": "appServer"
            },
            {
              "input": "mcp_resume",
              "runtimeKind": "acp"
            }
          ]
        }
      },
      "kind": "providerRuntimeDescriptorReader",
      "providerId": "codex",
      "source": "./agent/identity/runtimeDescriptor"
    },
    "sessionControlAdapter": {
      "exportName": "CODEX_SESSION_CONTROL_ADAPTER",
      "generatedAdapter": {
        "configuredRuntimeKind": {
          "accountSettingsField": "codexBackendMode",
          "aliases": [
            {
              "input": "acp",
              "runtimeKind": "acp"
            },
            {
              "input": "appServer",
              "runtimeKind": "appServer"
            },
            {
              "input": "mcp",
              "runtimeKind": "appServer"
            },
            {
              "input": "mcp_resume",
              "runtimeKind": "acp"
            }
          ],
          "booleanTrueField": "experimentalCodexAcp",
          "booleanTrueRuntimeKind": "acp",
          "defaultRuntimeKind": "appServer"
        },
        "controlRuntimeKind": {
          "aliases": [
            {
              "input": "acp",
              "runtimeKind": "acp"
            },
            {
              "input": "appServer",
              "runtimeKind": "appServer"
            },
            {
              "input": "mcp",
              "runtimeKind": "mcp"
            },
            {
              "input": "mcp_resume",
              "runtimeKind": "acp"
            }
          ],
          "genericState": {
            "fields": [
              "sessionModesV1",
              "sessionModelsV1",
              "sessionConfigOptionsV1",
              "acpSessionModesV1",
              "acpSessionModelsV1",
              "acpConfigOptionsV1"
            ],
            "providerId": "codex",
            "runtimeKind": "appServer"
          },
          "metadataPaths": [
            {
              "path": [
                "codexRuntimeDescriptorV1",
                "backendMode"
              ]
            },
            {
              "path": [
                "affinity",
                "backendMode"
              ]
            },
            {
              "path": [
                "codexBackendMode"
              ]
            },
            {
              "path": [
                "directSessionV1",
                "codexBackendMode"
              ]
            },
            {
              "path": [
                "externalSessionV1",
                "codexBackendMode"
              ],
              "providerId": "codex"
            }
          ],
          "rawDescriptorPaths": [
            {
              "path": [
                "agent",
                "agentExtra",
                "runtimeHandle",
                "backendMode"
              ],
              "providerId": "codex"
            },
            {
              "path": [
                "agent",
                "agentExtra",
                "runtimeAffinity",
                "backendMode"
              ],
              "providerId": "codex"
            },
            {
              "path": [
                "agent",
                "backendMode"
              ],
              "providerId": "codex"
            },
            {
              "path": [
                "provider",
                "providerExtra",
                "runtimeHandle",
                "backendMode"
              ],
              "providerId": "codex"
            },
            {
              "path": [
                "provider",
                "providerExtra",
                "runtimeAffinity",
                "backendMode"
              ],
              "providerId": "codex"
            },
            {
              "path": [
                "provider",
                "backendMode"
              ],
              "providerId": "codex"
            }
          ]
        },
        "experimentalVendorHandoff": {
          "accountSettingsField": "codexBackendMode",
          "accountSettingsValues": [
            "acp",
            "appServer",
            "mcp_resume"
          ],
          "booleanTrueField": "experimentalCodexAcp",
          "runtimeKinds": [
            "acp",
            "appServer"
          ]
        },
        "experimentalVendorResume": {
          "accountSettingsField": "codexBackendMode",
          "accountSettingsValues": [
            "acp",
            "appServer",
            "mcp_resume"
          ],
          "booleanTrueField": "experimentalCodexAcp",
          "requireConfiguredRuntimeKind": true,
          "runtimeKinds": [
            "acp",
            "appServer"
          ]
        },
        "providerId": "codex",
        "runtimeDescriptor": {
          "backendModeKey": "backendMode",
          "fields": [
            {
              "key": "backendMode",
              "kind": "runtimeKind",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "providerSessionId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "home",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "connectedServiceId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "connectedServiceProfileId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "connectedServiceGroupId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "homePath",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            }
          ],
          "legacy": {
            "fields": [
              {
                "key": "backendMode",
                "kind": "runtimeKind",
                "runtimeHandle": "whenPresent",
                "sourceKey": "codexBackendMode"
              },
              {
                "key": "providerSessionId",
                "kind": "trimmedString",
                "runtimeHandle": "whenPresent",
                "sourceKey": "codexSessionId"
              },
              {
                "key": "home",
                "kind": "trimmedString",
                "runtimeHandle": "whenPresent"
              },
              {
                "key": "connectedServiceId",
                "kind": "trimmedString",
                "runtimeHandle": "whenPresent"
              },
              {
                "key": "connectedServiceProfileId",
                "kind": "trimmedString",
                "runtimeHandle": "whenPresent"
              },
              {
                "key": "connectedServiceGroupId",
                "kind": "trimmedString",
                "runtimeHandle": "whenPresent"
              },
              {
                "key": "homePath",
                "kind": "trimmedString",
                "runtimeHandle": "whenPresent"
              }
            ],
            "requireRuntimeKind": true
          },
          "providerId": "codex",
          "runtimeKind": {
            "aliases": [
              {
                "input": "acp",
                "runtimeKind": "acp"
              },
              {
                "input": "appServer",
                "runtimeKind": "appServer"
              },
              {
                "input": "mcp",
                "runtimeKind": "appServer"
              },
              {
                "input": "mcp_resume",
                "runtimeKind": "acp"
              }
            ]
          }
        },
        "runtimeKindOverride": {
          "accountSettingsField": "codexBackendMode",
          "aliases": [
            {
              "input": "acp",
              "runtimeKind": "acp"
            },
            {
              "input": "appServer",
              "runtimeKind": "appServer"
            },
            {
              "input": "mcp",
              "runtimeKind": "appServer"
            },
            {
              "input": "mcp_resume",
              "runtimeKind": "acp"
            }
          ]
        },
        "vendorResumeId": {
          "descriptorField": "providerSessionId",
          "legacyField": "codexSessionId"
        }
      },
      "kind": "providerSessionControlAdapter",
      "providerId": "codex",
      "source": "./agent/surfaces/sessions/controls/adapter"
    }
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "metadata-gating",
    "semantics": "policy-presets",
    "source": "acp"
  },
  "sessionModesKind": "acpPolicyPresets"
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
  "agentSettings": null,
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
  "runtimeContributions": {
    "agentCatalogEntry": {
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
    "alternativeBinaryFallbackEnabledEnvVar": "HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED",
    "alternativeBinaryNames": [
      "agent"
    ],
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
  "agentSettings": null,
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
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "CURSOR_PROVIDER_RUNTIME_CONTRIBUTION",
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
    "setupRecommendation": {
      "order": 30
    },
    "sourcePreferenceDefault": "system-first",
    "title": "Google Gemini CLI"
  },
  "agentSettings": null,
  "authProbeConfig": {
    "agentId": "gemini",
    "backgroundChecks": "safe",
    "binaryNames": [
      "gemini"
    ],
    "credentialPaths": [],
    "envVars": [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION"
    ],
    "parser": "envOnly",
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
          "token"
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
        "checkNow": "unsupported"
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
    "loginLaunch": null,
    "machineLoginKey": "gemini",
    "supportKind": "unsupported"
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
    "dynamicProbe": "static-only",
    "freeformModelIdPrefixes": [
      "gemini-",
      "models/gemini-",
      "publishers/google/models/gemini-"
    ],
    "nonAcpApplyScope": "next_prompt",
    "staticModels": [
      {
        "description": "Best for complex reasoning, coding, and longer-running tasks.",
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro"
      },
      {
        "description": "Fast, balanced Gemini model for general-purpose work.",
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash"
      },
      {
        "description": "Lowest-latency Gemini 2.5 option for lightweight prompts.",
        "id": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash Lite"
      },
      {
        "description": "Preview flash model from the Gemini 3 generation.",
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview"
      },
      {
        "description": "Preview pro model with stronger reasoning and coding depth.",
        "id": "gemini-3-pro-preview",
        "name": "Gemini 3 Pro Preview"
      },
      {
        "description": "Latest Gemini 3.1 preview with the strongest reasoning in this static list.",
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview"
      }
    ],
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "GEMINI_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    },
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
  "agentSettings": null,
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
  "runtimeContributions": {
    "agentCatalogEntry": {
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
  "agentSettings": null,
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
  "runtimeContributions": {
    "agentCatalogEntry": {
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
  "kiro": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "kiro-cli",
    "docsUrl": "https://kiro.dev/docs/cli/acp/",
    "id": "kiro",
    "knownUserBinDirSuffixes": null,
    "managedInstall": null,
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "Kiro CLI"
  },
  "agentSettings": null,
  "authProbeConfig": {
    "agentId": "kiro",
    "backgroundChecks": "manual_only",
    "binaryNames": [
      "kiro-cli"
    ],
    "parser": "kiroWhoamiJson",
    "statusCommand": [
      "whoami",
      "--format",
      "json"
    ]
  },
  "core": {
    "cliSubcommand": "kiro",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "kiro-cli",
    "flavorAliases": [
      "kiro-cli"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "kiro",
    "localControl": {
      "attachStrategy": "unsupported",
      "supported": true,
      "topology": "exclusive"
    },
    "resume": {
      "vendorResume": "experimental",
      "vendorResumeIdField": "kiroSessionId"
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
      "delivery": "native_mcp",
      "support": "supported"
    }
  },
  "id": "kiro",
  "localCli": {
    "agentId": "kiro",
    "detectKey": "kiro-cli",
    "loginLaunch": {
      "args": [
        "login"
      ],
      "command": "kiro-cli"
    },
    "machineLoginKey": "kiro-cli",
    "supportKind": "login_terminal"
  },
  "modelConfig": {
    "acpApplyBehavior": "set_model",
    "acpModelConfigOptionId": "model",
    "allowedModes": [
      "default"
    ],
    "defaultMode": "default",
    "dynamicProbe": "static-only",
    "nonAcpApplyScope": "next_prompt",
    "supportsFreeform": true,
    "supportsSelection": true
  },
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "KIRO_PROVIDER_RUNTIME_CONTRIBUTION",
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
  "agentSettings": null,
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
  "builtInAcpConfig": {
    "agentId": "ohMyPi",
    "launcher": {
      "args": [
        "--mode",
        "acp"
      ],
      "command": "omp"
    },
    "promptImageSupport": "yes",
    "supportsLoadSession": true,
    "supportsModels": "yes",
    "supportsModes": "yes",
    "transportProfile": "generic"
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
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "OH_MY_PI_PROVIDER_RUNTIME_CONTRIBUTION",
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
    "managedInstall": {
      "binaryName": "opencode",
      "kind": "managed_package",
      "packageBinarySetup": {
        "kind": "opencode_platform_binary"
      },
      "packageName": "opencode-ai"
    },
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "setupRecommendation": {
      "order": 40
    },
    "sourcePreferenceDefault": "system-first",
    "title": "OpenCode CLI"
  },
  "agentSettings": null,
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
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    },
    "protocolRuntimeDescriptor": {
      "buildFunction": "buildOpenCodeAgentRuntimeDescriptorV1",
      "canonicalReader": "readCanonicalOpenCodeAgentRuntimeDescriptorV1",
      "kind": "providerRuntimeDescriptorV1",
      "providerId": "opencode",
      "source": "./protocol/runtimeDescriptorV1"
    },
    "runtimeDescriptorReader": {
      "exportName": "readOpenCodeSessionMetadataRuntimeDescriptor",
      "generatedReader": {
        "backendModeKey": "backendMode",
        "fields": [
          {
            "key": "backendMode",
            "kind": "runtimeKind",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "providerSessionId",
            "kind": "trimmedString",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "serverBaseUrl",
            "kind": "loopbackHttpOrigin",
            "runtimeHandle": "whenPresent"
          },
          {
            "key": "serverBaseUrlExplicit",
            "kind": "booleanTrue",
            "requiresField": "serverBaseUrl",
            "runtimeHandle": "booleanTrue"
          }
        ],
        "legacy": {
          "defaultRuntimeKindWhenAnyFieldPresent": "server",
          "fields": [
            {
              "key": "backendMode",
              "kind": "runtimeKind",
              "runtimeHandle": "whenPresent",
              "sourceKey": "opencodeBackendMode"
            },
            {
              "key": "providerSessionId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent",
              "sourceKey": "opencodeSessionId"
            },
            {
              "key": "serverBaseUrl",
              "kind": "loopbackHttpOrigin",
              "runtimeHandle": "whenPresent",
              "sourceKey": "opencodeServerBaseUrl"
            },
            {
              "key": "serverBaseUrlExplicit",
              "kind": "booleanTrue",
              "requiresField": "serverBaseUrl",
              "runtimeHandle": "booleanTrue",
              "sourceKey": "opencodeServerBaseUrlExplicit"
            }
          ]
        },
        "providerId": "opencode",
        "runtimeKind": {
          "aliases": [
            {
              "input": "server",
              "runtimeKind": "server"
            },
            {
              "input": "acp",
              "runtimeKind": "acp"
            }
          ],
          "caseInsensitive": true
        }
      },
      "kind": "providerRuntimeDescriptorReader",
      "providerId": "opencode",
      "source": "./agent/identity/runtimeDescriptor"
    },
    "sessionControlAdapter": {
      "exportName": "OPENCODE_SESSION_CONTROL_ADAPTER",
      "generatedAdapter": {
        "configuredRuntimeKind": {
          "accountSettingsField": "opencodeBackendMode",
          "aliases": [
            {
              "input": "server",
              "runtimeKind": "server"
            },
            {
              "input": "acp",
              "runtimeKind": "acp"
            }
          ],
          "caseInsensitive": true
        },
        "providerId": "opencode",
        "runtimeDescriptor": {
          "backendModeKey": "backendMode",
          "fields": [
            {
              "key": "backendMode",
              "kind": "runtimeKind",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "providerSessionId",
              "kind": "trimmedString",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "serverBaseUrl",
              "kind": "loopbackHttpOrigin",
              "runtimeHandle": "whenPresent"
            },
            {
              "key": "serverBaseUrlExplicit",
              "kind": "booleanTrue",
              "requiresField": "serverBaseUrl",
              "runtimeHandle": "booleanTrue"
            }
          ],
          "legacy": {
            "defaultRuntimeKindWhenAnyFieldPresent": "server",
            "fields": [
              {
                "key": "backendMode",
                "kind": "runtimeKind",
                "runtimeHandle": "whenPresent",
                "sourceKey": "opencodeBackendMode"
              },
              {
                "key": "providerSessionId",
                "kind": "trimmedString",
                "runtimeHandle": "whenPresent",
                "sourceKey": "opencodeSessionId"
              },
              {
                "key": "serverBaseUrl",
                "kind": "loopbackHttpOrigin",
                "runtimeHandle": "whenPresent",
                "sourceKey": "opencodeServerBaseUrl"
              },
              {
                "key": "serverBaseUrlExplicit",
                "kind": "booleanTrue",
                "requiresField": "serverBaseUrl",
                "runtimeHandle": "booleanTrue",
                "sourceKey": "opencodeServerBaseUrlExplicit"
              }
            ]
          },
          "providerId": "opencode",
          "runtimeKind": {
            "aliases": [
              {
                "input": "server",
                "runtimeKind": "server"
              },
              {
                "input": "acp",
                "runtimeKind": "acp"
              }
            ],
            "caseInsensitive": true
          }
        },
        "runtimeKindOverride": {
          "accountSettingsField": "opencodeBackendMode",
          "aliases": [
            {
              "input": "server",
              "runtimeKind": "server"
            },
            {
              "input": "acp",
              "runtimeKind": "acp"
            }
          ],
          "caseInsensitive": true,
          "fallbackRuntimeKind": "server"
        },
        "vendorResumeId": {
          "descriptorField": "providerSessionId",
          "legacyField": "opencodeSessionId"
        }
      },
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
  "agentSettings": null,
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
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "PI_PROVIDER_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
    },
    "protocolRuntimeDescriptor": {
      "buildFunction": "buildPiAgentRuntimeDescriptorV1",
      "canonicalReader": "readCanonicalPiAgentRuntimeDescriptorV1",
      "kind": "providerRuntimeDescriptorV1",
      "providerId": "pi",
      "source": "./protocol/runtimeDescriptorV1"
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
  "agentSettings": null,
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
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
  "coderabbit": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "coderabbit",
    "docsUrl": null,
    "id": "coderabbit",
    "installGuideUrl": null,
    "knownUserBinDirSuffixes": null,
    "managedInstall": null,
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "CodeRabbit"
  },
  "agentSettings": null,
  "authProbeConfig": {
    "agentId": "coderabbit",
    "backgroundChecks": "safe",
    "binaryNames": [
      "coderabbit"
    ],
    "envVars": [
      "CODERABBIT_API_KEY"
    ],
    "parser": "unknown",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "coderabbit",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "coderabbit",
    "flavorAliases": [],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "coderabbit",
    "resume": {
      "vendorResume": "unsupported"
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
  "id": "coderabbit",
  "localCli": {
    "agentId": "coderabbit",
    "detectKey": "coderabbit",
    "loginLaunch": null,
    "machineLoginKey": "coderabbit",
    "supportKind": "status_only"
  },
  "modelConfig": {
    "allowedModes": [
      "review"
    ],
    "defaultMode": "review",
    "dynamicProbe": "static-only",
    "nonAcpApplyScope": "next_prompt",
    "supportsSelection": false
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
  "deepsec": Object.freeze(({
  "agentCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "deepsec",
    "docsUrl": null,
    "id": "deepsec",
    "installGuideUrl": null,
    "knownUserBinDirSuffixes": null,
    "managedInstall": null,
    "manualInstallKind": "command",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "DeepSec"
  },
  "agentSettings": null,
  "authProbeConfig": {
    "agentId": "deepsec",
    "backgroundChecks": "safe",
    "binaryNames": [
      "deepsec"
    ],
    "envVars": [
      "AI_GATEWAY_API_KEY"
    ],
    "parser": "unknown",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "deepsec",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "deepsec",
    "flavorAliases": [],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "deepsec",
    "resume": {
      "vendorResume": "unsupported"
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
  "id": "deepsec",
  "localCli": {
    "agentId": "deepsec",
    "detectKey": "deepsec",
    "loginLaunch": null,
    "machineLoginKey": "deepsec",
    "supportKind": "status_only"
  },
  "modelConfig": {
    "allowedModes": [
      "review",
      "repository_security_audit"
    ],
    "defaultMode": "review",
    "dynamicProbe": "static-only",
    "nonAcpApplyScope": "next_prompt",
    "supportsSelection": false
  },
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
}) as const satisfies Readonly<Record<string, BundledAgentDefinition>>;

export const BUNDLED_AGENT_DEFINITIONS_BY_ID: Readonly<Record<string, BundledAgentDefinition>> = Object.freeze(_BUNDLED_AGENT_DEFINITIONS_BY_ID);

// Canonical generated aggregate exports (avoid "*families*" naming).
export const bundledAgentDefinitionIds = BUNDLED_AGENT_DEFINITION_IDS;
export const bundledAgentDefinitions = BUNDLED_AGENT_DEFINITIONS_BY_ID;
