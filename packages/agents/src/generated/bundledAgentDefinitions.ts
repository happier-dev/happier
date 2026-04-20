/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { AgentDefinition } from '../definitions/agentDefinition.js';

export const BUNDLED_AGENT_DEFINITION_IDS: readonly string[] = Object.freeze([
  "claude",
  "codex",
  "opencode",
]);

const _BUNDLED_AGENT_DEFINITIONS_BY_ID = ({
  "claude": Object.freeze(({
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
    "sessionCapabilities": {
      "sessionFork": {
        "conversation": "unsupported",
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
        "description": "Newest highest-capability Claude model for the hardest coding and reasoning tasks.",
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
          }
        ],
        "name": "Opus 4.7"
      },
      {
        "description": "Highest-capability Claude model for the hardest coding and reasoning tasks.",
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
  "providerCliRuntime": {
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
    "sourcePreferenceDefault": "system-first",
    "title": "Claude Code CLI"
  },
  "providerSettings": null,
  "sessionModeDescriptor": {
    "runtimeSwitch": "provider-native",
    "semantics": "agent-modes",
    "source": "provider-native"
  },
  "sessionModesKind": "staticAgentModes"
}) as const),
  "codex": Object.freeze(({
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
  "providerCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "codex",
    "id": "codex",
    "managedInstall": null,
    "manualInstallKind": "none",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "codex CLI"
  },
  "providerSettings": null,
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
  "opencode": Object.freeze(({
  "authProbeConfig": {
    "agentId": "opencode",
    "backgroundChecks": "safe",
    "binaryNames": [
      "opencode"
    ],
    "parser": "unknown",
    "statusCommand": null
  },
  "core": {
    "cliSubcommand": "opencode",
    "detectKey": "opencode",
    "handoff": {
      "vendorStateTransfer": "unsupported"
    },
    "id": "opencode",
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
  "id": "opencode",
  "localCli": {
    "agentId": "opencode",
    "detectKey": "opencode",
    "loginLaunch": null,
    "machineLoginKey": "opencode",
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
  "providerCliRuntime": {
    "acceptsJavaScriptFileOverride": false,
    "binaryName": "opencode",
    "id": "opencode",
    "managedInstall": null,
    "manualInstallKind": "none",
    "manualInstallRecipes": null,
    "sourcePreferenceDefault": "system-first",
    "title": "opencode CLI"
  },
  "providerSettings": null,
  "sessionModeDescriptor": {
    "runtimeSwitch": "none",
    "semantics": "none",
    "source": "none"
  },
  "sessionModesKind": "none"
}) as const),
}) as const satisfies Readonly<Record<string, AgentDefinition>>;

export const BUNDLED_AGENT_DEFINITIONS_BY_ID = Object.freeze(_BUNDLED_AGENT_DEFINITIONS_BY_ID);

// Canonical generated aggregate exports (avoid "*families*" naming).
export const bundledAgentDefinitionIds = BUNDLED_AGENT_DEFINITION_IDS;
export const bundledAgentDefinitions = BUNDLED_AGENT_DEFINITIONS_BY_ID;
