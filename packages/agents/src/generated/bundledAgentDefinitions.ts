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
  "grok",
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [],
          "kind": "primary"
        }
      ],
      "machineLoginKey": "antigravity-cli",
      "probe": {
        "backgroundChecks": "manual_only",
        "parser": "none",
        "statusArgs": null
      },
      "support": "login_terminal"
    },
    "displayName": "Antigravity CLI",
    "executable": {
      "binaryName": "agy",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://antigravity.google/docs/cli-install",
      "guideUrl": "https://antigravity.google/docs/cli-install",
      "managed": null,
      "manual": {
        "kind": "vendor_recipe",
        "recipes": {
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
        }
      }
    }
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
      "vendorResume": "supported",
      "vendorResumeIdField": "antigravitySessionId"
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
      "importName": "ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [
            "login"
          ],
          "kind": "primary"
        }
      ],
      "probe": {
        "backgroundChecks": "safe",
        "parser": "unknown",
        "statusArgs": null
      },
      "support": "login_terminal"
    },
    "displayName": "Auggie CLI",
    "executable": {
      "binaryName": "auggie",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://augmentcode.com",
      "managed": {
        "binaryName": "auggie",
        "kind": "managed_package",
        "packageName": "@augmentcode/auggie"
      },
      "manual": {
        "kind": "command"
      }
    }
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
      "importName": "AUGGIE_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [],
          "initialInput": "/login\r",
          "kind": "primary"
        }
      ],
      "machineLoginKey": "claude-code",
      "probe": {
        "backgroundChecks": "safe",
        "credentialPaths": [
          "~/.claude/.credentials.json",
          "~/.claude/.claude.json"
        ],
        "envVars": [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN"
        ],
        "parser": "claudeCredentialsFile",
        "statusArgs": null
      },
      "support": "login_terminal"
    },
    "displayName": "Claude Code CLI",
    "executable": {
      "acceptsJavaScriptFileOverride": true,
      "binaryName": "claude",
      "knownUserBinDirSuffixes": [
        ".local/bin"
      ],
      "sourcePreference": "system-first",
      "systemCommandResolutionStrategy": "known-user-first-runnable"
    },
    "install": {
      "docsUrl": "https://claude.ai",
      "guideUrl": "https://code.claude.com/docs/en/setup",
      "managed": null,
      "manual": {
        "kind": "vendor_recipe",
        "recipes": {
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
        }
      },
      "recommendationOrder": 10
    }
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
  "modelConfig": {
    "allowedModes": [
      "claude-opus-5",
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
        "description": "Latest highest-capability Claude model for the hardest coding and reasoning tasks.",
        "id": "claude-opus-5",
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
        "name": "Opus 5"
      },
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
      "importName": "CLAUDE_AGENT_RUNTIME_CONTRIBUTION",
      "source": "./agent/contributions/runtime"
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [
            "login"
          ],
          "kind": "primary"
        }
      ],
      "probe": {
        "backgroundChecks": "safe",
        "credentialPaths": [
          "~/.codex/auth.json"
        ],
        "envVars": [
          "OPENAI_API_KEY",
          "CODEX_API_KEY"
        ],
        "parser": "codexLoginStatus",
        "statusArgs": [
          "login",
          "status"
        ]
      },
      "support": "login_terminal"
    },
    "displayName": "OpenAI Codex CLI",
    "executable": {
      "binaryName": "codex",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://github.com/openai/codex",
      "guideUrl": null,
      "managed": {
        "binaryName": "codex",
        "githubRepo": "openai/codex",
        "kind": "github_release_binary"
      },
      "manual": {
        "kind": "command"
      },
      "recommendationOrder": 20
    }
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
      "importName": "CODEX_AGENT_RUNTIME_CONTRIBUTION",
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
              ],
              "providerId": "codex"
            },
            {
              "path": [
                "externalSessionV1",
                "codexBackendMode"
              ]
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [
            "login"
          ],
          "kind": "primary"
        }
      ],
      "probe": {
        "backgroundChecks": "safe",
        "envVars": [
          "COPILOT_GITHUB_TOKEN",
          "GH_TOKEN",
          "GITHUB_TOKEN"
        ],
        "parser": "copilotGhAuth",
        "statusArgs": null
      },
      "support": "login_terminal"
    },
    "displayName": "GitHub Copilot CLI",
    "executable": {
      "binaryName": "copilot",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
      "guideUrl": null,
      "managed": {
        "binaryName": "copilot",
        "kind": "managed_package",
        "packageName": "@github/copilot"
      },
      "manual": {
        "kind": "command"
      }
    }
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
      "importName": "COPILOT_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [],
      "probe": {
        "backgroundChecks": "safe",
        "envVars": [
          "CURSOR_API_KEY"
        ],
        "parser": "cursorAboutJson",
        "statusArgs": [
          "about",
          "--format",
          "json"
        ]
      },
      "support": "status_only"
    },
    "displayName": "Cursor Agent CLI",
    "executable": {
      "alternativeBinaryFallbackEnabledEnvVar": "HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED",
      "alternativeBinaryNames": [
        "agent"
      ],
      "binaryName": "cursor-agent",
      "knownUserBinDirSuffixes": [
        ".local/bin"
      ],
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://cursor.com/docs/cli",
      "guideUrl": "https://cursor.com/docs/cli/installation",
      "managed": null,
      "manual": {
        "kind": "vendor_recipe"
      }
    }
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
      "importName": "CURSOR_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [],
      "probe": {
        "backgroundChecks": "safe",
        "envVars": [
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "GOOGLE_GENAI_USE_VERTEXAI",
          "GOOGLE_CLOUD_PROJECT",
          "GOOGLE_CLOUD_LOCATION"
        ],
        "parser": "envOnly",
        "statusArgs": null
      },
      "support": "unsupported"
    },
    "displayName": "Google Gemini CLI",
    "executable": {
      "binaryName": "gemini",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://goo.gle/gemini-cli-auth-docs",
      "guideUrl": null,
      "managed": {
        "binaryName": "gemini",
        "kind": "managed_package",
        "packageName": "@google/gemini-cli"
      },
      "manual": {
        "kind": "command"
      },
      "recommendationOrder": 30
    }
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
      "importName": "GEMINI_AGENT_RUNTIME_CONTRIBUTION",
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
  "grok": Object.freeze(({
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [
            "login"
          ],
          "kind": "primary"
        },
        {
          "args": [
            "login",
            "--device-auth"
          ],
          "kind": "device_code"
        }
      ],
      "probe": {
        "backgroundChecks": "safe",
        "envVars": [
          "XAI_API_KEY"
        ],
        "parser": "unknown",
        "statusArgs": null
      },
      "support": "login_terminal"
    },
    "displayName": "Grok",
    "executable": {
      "binaryName": "grok",
      "knownUserBinDirSuffixes": [
        ".grok/bin",
        ".local/bin"
      ],
      "sourcePreference": "system-first",
      "systemCommandResolutionStrategy": "path-first"
    },
    "install": {
      "docsUrl": "https://x.ai",
      "guideUrl": "https://x.ai/cli",
      "managed": null,
      "manual": {
        "kind": "vendor_recipe",
        "recipes": {
          "darwin": [
            {
              "args": [
                "-lc",
                "curl -fsSL https://x.ai/cli/install.sh | bash"
              ],
              "cmd": "bash"
            }
          ],
          "linux": [
            {
              "args": [
                "-lc",
                "curl -fsSL https://x.ai/cli/install.sh | bash"
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
                "irm https://x.ai/cli/install.ps1 | iex"
              ],
              "cmd": "powershell"
            }
          ]
        }
      }
    }
  },
  "core": {
    "cliSubcommand": "grok",
    "cloudConnect": null,
    "connectedServices": null,
    "detectKey": "grok",
    "flavorAliases": [
      "grok-build",
      "grok-cli"
    ],
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "grok",
    "resume": {
      "vendorResume": "supported",
      "vendorResumeIdField": "grokSessionId"
    },
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "supported",
        "fromMessage": "supported"
      },
      "sessionListing": "unsupported",
      "sessionRollback": {
        "conversation": "supported"
      }
    },
    "sessionStorage": {
      "direct": false,
      "persisted": true
    },
    "tools": {
      "delivery": "native_mcp",
      "support": "experimental"
    }
  },
  "id": "grok",
  "modelConfig": {
    "acpApplyBehavior": "set_model",
    "allowedModes": [],
    "defaultMode": null,
    "dynamicProbe": "auto",
    "nonAcpApplyScope": "next_prompt",
    "supportsSelection": true
  },
  "runtimeContributions": {
    "agentCatalogEntry": {
      "importName": "GROK_AGENT_RUNTIME_CONTRIBUTION",
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
  "kilo": Object.freeze(({
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [],
          "initialInput": "/connect\r",
          "kind": "primary"
        }
      ],
      "probe": {
        "backgroundChecks": "safe",
        "parser": "unknown",
        "statusArgs": null
      },
      "support": "login_terminal"
    },
    "displayName": "Kilo CLI",
    "executable": {
      "binaryName": "kilo",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://kilo.ai/docs/cli",
      "guideUrl": null,
      "managed": {
        "binaryName": "kilo",
        "kind": "managed_package",
        "packageName": "@kilocode/cli"
      },
      "manual": {
        "kind": "command"
      }
    }
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
      "importName": "KILO_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [
            "login"
          ],
          "kind": "primary"
        }
      ],
      "probe": {
        "backgroundChecks": "safe",
        "parser": "unknown",
        "statusArgs": null
      },
      "support": "login_terminal"
    },
    "displayName": "Kimi CLI",
    "executable": {
      "binaryName": "kimi",
      "knownUserBinDirSuffixes": [
        ".local/bin"
      ],
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://code.kimi.com",
      "guideUrl": "https://kimi.moonshot.cn/docs/cli",
      "managed": null,
      "manual": {
        "kind": "vendor_recipe",
        "recipes": {
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
        }
      }
    }
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
      "importName": "KIMI_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [
            "login"
          ],
          "kind": "primary"
        }
      ],
      "probe": {
        "backgroundChecks": "manual_only",
        "parser": "kiroWhoamiJson",
        "statusArgs": [
          "whoami",
          "--format",
          "json"
        ]
      },
      "support": "login_terminal"
    },
    "displayName": "Kiro CLI",
    "executable": {
      "binaryName": "kiro-cli",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://kiro.dev/docs/cli/acp/",
      "managed": null,
      "manual": {
        "kind": "command"
      }
    }
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
      "importName": "KIRO_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [],
      "machineLoginKey": "oh-my-pi",
      "probe": {
        "backgroundChecks": "safe",
        "envVars": [
          "OPENAI_CODEX_OAUTH_TOKEN",
          "OPENAI_API_KEY",
          "ANTHROPIC_OAUTH_TOKEN",
          "ANTHROPIC_API_KEY",
          "GEMINI_API_KEY"
        ],
        "parser": "piEnvOnly",
        "statusArgs": null
      },
      "support": "manual_only"
    },
    "displayName": "oh-my-pi CLI",
    "executable": {
      "acceptsJavaScriptFileOverride": true,
      "binaryName": "omp",
      "knownUserBinDirSuffixes": [
        ".bun/bin"
      ],
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://github.com/can1357/oh-my-pi",
      "guideUrl": "https://github.com/can1357/oh-my-pi#via-bun-recommended",
      "managed": {
        "binaryName": "omp",
        "githubRepo": "can1357/oh-my-pi",
        "kind": "github_release_binary"
      },
      "manual": {
        "kind": "vendor_recipe",
        "recipes": {
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
        }
      }
    }
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
      "importName": "OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [
            "auth",
            "login"
          ],
          "kind": "primary"
        }
      ],
      "probe": {
        "backgroundChecks": "safe",
        "parser": "opencodeAuthList",
        "statusArgs": [
          "auth",
          "list"
        ]
      },
      "support": "login_terminal"
    },
    "displayName": "OpenCode CLI",
    "executable": {
      "binaryName": "opencode",
      "knownUserBinDirSuffixes": [
        ".opencode/bin",
        "AppData/Roaming/npm"
      ],
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": "https://opencode.ai",
      "guideUrl": "https://opencode.ai/docs",
      "managed": {
        "binaryName": "opencode",
        "kind": "managed_package",
        "packageBinarySetup": {
          "kind": "opencode_platform_binary"
        },
        "packageName": "opencode-ai"
      },
      "manual": {
        "kind": "command"
      },
      "recommendationOrder": 40
    }
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
      "importName": "OPENCODE_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [],
      "probe": {
        "backgroundChecks": "safe",
        "envVars": [
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "GEMINI_API_KEY",
          "OPENROUTER_API_KEY",
          "KIMI_API_KEY"
        ],
        "parser": "piEnvOnly",
        "statusArgs": null
      },
      "support": "status_only"
    },
    "displayName": "Pi Coding Agent CLI",
    "executable": {
      "binaryName": "pi",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": null,
      "guideUrl": "https://github.com/badlogic/pi-mono",
      "managed": {
        "binaryName": "pi",
        "kind": "managed_package",
        "packageName": "@earendil-works/pi-coding-agent"
      },
      "manual": {
        "kind": "command"
      }
    }
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
      "importName": "PI_AGENT_RUNTIME_CONTRIBUTION",
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
  "cli": {
    "auth": {
      "loginLaunches": [
        {
          "args": [],
          "initialInput": "/auth\r",
          "kind": "primary"
        }
      ],
      "probe": {
        "backgroundChecks": "safe",
        "parser": "unknown",
        "statusArgs": null
      },
      "support": "login_terminal"
    },
    "displayName": "Qwen CLI",
    "executable": {
      "binaryName": "qwen",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": null,
      "guideUrl": "https://qwenlm.github.io/qwen-code-docs/",
      "managed": {
        "binaryName": "qwen",
        "kind": "managed_package",
        "packageName": "@qwen-code/qwen-code"
      },
      "manual": {
        "kind": "command"
      }
    }
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
  "cli": {
    "auth": {
      "loginLaunches": [],
      "probe": {
        "backgroundChecks": "safe",
        "envVars": [
          "CODERABBIT_API_KEY"
        ],
        "parser": "unknown",
        "statusArgs": null
      },
      "support": "status_only"
    },
    "displayName": "CodeRabbit",
    "executable": {
      "binaryName": "coderabbit",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": null,
      "guideUrl": null,
      "managed": null,
      "manual": {
        "kind": "command"
      }
    }
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
  "cli": {
    "auth": {
      "loginLaunches": [],
      "probe": {
        "backgroundChecks": "safe",
        "envVars": [
          "AI_GATEWAY_API_KEY"
        ],
        "parser": "unknown",
        "statusArgs": null
      },
      "support": "status_only"
    },
    "displayName": "DeepSec",
    "executable": {
      "binaryName": "deepsec",
      "knownUserBinDirSuffixes": null,
      "sourcePreference": "system-first"
    },
    "install": {
      "docsUrl": null,
      "guideUrl": null,
      "managed": null,
      "manual": {
        "kind": "command"
      }
    }
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
