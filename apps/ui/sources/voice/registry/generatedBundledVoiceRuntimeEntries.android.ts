/**
 * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-RUNTIME-PROJECTION)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Executable first-party Voice activation roots for android.
 * Contributions that do not declare this host platform are absent.
 */

import { createBundledConversationRuntimeEntries, type BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';
import { activate as CODEX_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-codex/ui/voice';
import { activate as ELEVENLABS_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-elevenlabs/ui/voice';
import { activate as OPENAI_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-openai/ui/voice';
import { activate as XAI_BUNDLED_VOICE_ACTIVATE } from '@happier-dev/plugins-xai/ui/voice';

const CODEX_BUNDLED_PLUGIN_MANIFEST = Object.freeze(
{
  "contributes": {
    "accountCollections": [],
    "actions": [],
    "agents": [
      {
        "capabilities": {
          "executionRuns": {
            "checkpoint": true,
            "open": [
              "create",
              "resume"
            ],
            "stop": true
          },
          "sessions": {
            "cancel": true,
            "catalog": {
              "active": [
                "vendorPlugins",
                "skills"
              ],
              "inactive": [
                "vendorPlugins",
                "skills"
              ]
            },
            "configuration": true,
            "continuationVerification": {
              "intents": [
                "resume",
                "fork"
              ],
              "requirement": "required"
            },
            "conversationRollback": true,
            "delivery": [
              "newTurn",
              "steer",
              "followUp"
            ],
            "goals": {
              "active": {
                "clear": true,
                "get": true,
                "set": {
                  "fields": [
                    "objective",
                    "status",
                    "tokenBudget"
                  ],
                  "writableStatuses": [
                    "active",
                    "paused",
                    "complete"
                  ]
                }
              },
              "inactive": {
                "clear": true,
                "get": true,
                "set": {
                  "fields": [
                    "objective",
                    "status",
                    "tokenBudget"
                  ],
                  "writableStatuses": [
                    "active",
                    "paused",
                    "complete"
                  ]
                }
              },
              "source": "goals"
            },
            "open": [
              "create",
              "resume",
              "fork"
            ],
            "startupInstructions": {
              "versions": [
                1
              ]
            },
            "usageLimitRecovery": {
              "active": [
                "checkNow"
              ],
              "inactive": [
                "checkNow"
              ]
            },
            "workStateSources": [
              {
                "id": "goals",
                "itemKinds": [
                  "goal"
                ]
              }
            ]
          },
          "surfaces": [
            "terminal",
            "externalSessions"
          ],
          "tools": {
            "delivery": "native_mcp"
          }
        },
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
              "archiveEntriesByPlatform": {
                "darwin": [
                  {
                    "archivePath": "bin/codex",
                    "destinationPath": "bin/codex"
                  },
                  {
                    "archivePath": "bin/codex-code-mode-host",
                    "destinationPath": "bin/codex-code-mode-host"
                  }
                ],
                "linux": [
                  {
                    "archivePath": "bin/codex",
                    "destinationPath": "bin/codex"
                  },
                  {
                    "archivePath": "bin/codex-code-mode-host",
                    "destinationPath": "bin/codex-code-mode-host"
                  }
                ],
                "win32": [
                  {
                    "archivePath": "bin/codex.exe",
                    "destinationPath": "bin/codex.exe"
                  },
                  {
                    "archivePath": "bin/codex-code-mode-host.exe",
                    "destinationPath": "bin/codex-code-mode-host.exe"
                  },
                  {
                    "archivePath": "codex-resources/codex-command-runner.exe",
                    "destinationPath": "codex-resources/codex-command-runner.exe"
                  },
                  {
                    "archivePath": "codex-resources/codex-windows-sandbox-setup.exe",
                    "destinationPath": "codex-resources/codex-windows-sandbox-setup.exe"
                  }
                ]
              },
              "archiveExtractionLimits": {
                "maxExpandedBytes": 402653184,
                "maxFileBytes": 402653184
              },
              "assetNameByPlatform": {
                "darwin": {
                  "arm64": "codex-package-aarch64-apple-darwin.tar.gz",
                  "x64": "codex-package-x86_64-apple-darwin.tar.gz"
                },
                "linux": {
                  "arm64": "codex-package-aarch64-unknown-linux-musl.tar.gz",
                  "x64": "codex-package-x86_64-unknown-linux-musl.tar.gz"
                },
                "win32": {
                  "arm64": "codex-package-aarch64-pc-windows-msvc.tar.gz",
                  "x64": "codex-package-x86_64-pc-windows-msvc.tar.gz"
                }
              },
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
        "connectedAccounts": [
          {
            "materializationKinds": [
              "files"
            ],
            "purpose": "primary",
            "required": false,
            "service": "openai-codex"
          }
        ],
        "id": "codex",
        "primary": "sessions",
        "providerRequirements": {
          "acceptsProtocols": [
            "openai-responses"
          ],
          "applyPolicy": "restart_session",
          "authIsolation": {
            "ownedEnvKeys": [
              "HAPPIER_CODEX_PROVIDER_API_KEY",
              "OPENAI_API_KEY",
              "CODEX_API_KEY"
            ],
            "suppressConnectedServiceIds": [
              "openai-codex",
              "openai"
            ]
          },
          "credentialSupport": {
            "apiKeyTransports": [
              {
                "destination": {
                  "formats": [
                    "raw",
                    "bearer"
                  ],
                  "kind": "httpHeader",
                  "names": "anyValidated"
                },
                "protocol": "openai-responses"
              }
            ],
            "supportsNoAuth": true
          },
          "materialization": "engineConfig",
          "required": {
            "streaming": true,
            "toolRoundTrips": true
          },
          "supportsFreeformModelIds": true
        },
        "runtime": {
          "kind": "custom"
        },
        "surfaces": {
          "externalSession": {
            "externalLinkedTakeover": {
              "writerSafety": "unsupported"
            },
            "sources": [
              {
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
              }
            ]
          }
        },
        "title": "Codex"
      }
    ],
    "backgroundServices": [],
    "browserActions": [],
    "browserTargets": [],
    "commands": [],
    "composerAttachments": [],
    "composerControls": [],
    "composerReferences": [],
    "composerRegions": [],
    "connectedAccountDescriptors": [
      {
        "authentication": {
          "defaultModeId": "oauth",
          "modes": [
            {
              "id": "oauth",
              "kind": "oauthAuthorizationCode",
              "outcomeReconciliation": "none",
              "pkce": "required",
              "scopes": [
                "openid",
                "profile",
                "email",
                "offline_access"
              ]
            },
            {
              "id": "device",
              "kind": "oauthDeviceCode",
              "outcomeReconciliation": "none",
              "scopes": [
                "openid",
                "profile",
                "email",
                "offline_access"
              ]
            }
          ]
        },
        "id": "openai-codex",
        "title": "Codex"
      }
    ],
    "daemonDatabases": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [
      {
        "category": "decision",
        "executionKind": "decide",
        "filters": {
          "agentId": "codex"
        },
        "hookApiVersion": 1,
        "id": "resolve-prerequisites",
        "on": "agent.resolvePrerequisites",
        "scope": "agent"
      },
      {
        "category": "augmentation",
        "executionKind": "augment",
        "filters": {
          "agentId": "codex"
        },
        "hookApiVersion": 1,
        "id": "augment-spawn-env",
        "on": "agent.spawnEnv.augment",
        "scope": "daemon"
      }
    ],
    "managedDependencies": [
      {
        "executable": "codex-acp",
        "id": "codex-acp",
        "sources": [
          {
            "kind": "vendorRecipe",
            "recipeId": "codex-acp"
          }
        ],
        "title": "Codex ACP adapter"
      }
    ],
    "mcp": {
      "discoverySources": [
        {
          "id": "config",
          "metadata": {
            "agentId": "codex"
          },
          "title": "Codex MCP configuration"
        }
      ],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "sessionHeaderActions": [],
    "sessionInfoSections": [],
    "settings": [
      {
        "actions": [],
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
            "description": {
              "fallback": "Select App Server, ACP, or MCP.",
              "key": "settingsAgents.plugins.codex.fields.codexBackendMode.subtitle"
            },
            "id": "codexBackendMode",
            "presentation": {
              "control": "select",
              "options": [
                {
                  "description": {
                    "fallback": "Recommended official Codex app-server mode",
                    "key": "settingsAgents.plugins.codex.fields.codexBackendMode.options.appServer.subtitle"
                  },
                  "title": {
                    "fallback": "App Server",
                    "key": "settingsAgents.plugins.codex.fields.codexBackendMode.options.appServer.title"
                  },
                  "value": "appServer"
                },
                {
                  "description": {
                    "fallback": "Route Codex through ACP (codex-acp)",
                    "key": "settingsAgents.plugins.codex.fields.codexBackendMode.options.acp.subtitle"
                  },
                  "title": {
                    "fallback": "ACP",
                    "key": "settingsAgents.plugins.codex.fields.codexBackendMode.options.acp.title"
                  },
                  "value": "acp"
                }
              ]
            },
            "schema": {
              "description": "Preferred Codex backend mode",
              "enum": [
                "acp",
                "appServer",
                "mcp",
                "mcp_resume"
              ],
              "type": "string"
            },
            "title": {
              "fallback": "Codex routing mode",
              "key": "settingsAgents.plugins.codex.fields.codexBackendMode.title"
            }
          }
        ],
        "id": "agent-settings",
        "presentation": {
          "icon": {
            "color": {
              "kind": "theme",
              "token": "blue"
            },
            "ionName": "terminal-outline"
          },
          "sections": [
            {
              "description": {
                "fallback": "Choose how Codex is routed. App Server is the recommended default. Local/remote switching and resume work with App Server; ACP remains available as a legacy fallback.",
                "key": "settingsAgents.plugins.codex.sections.backendMode.footer"
              },
              "fields": [
                "codexBackendMode"
              ],
              "id": "codex-mode",
              "title": {
                "fallback": "Routing mode",
                "key": "settingsAgents.plugins.codex.sections.backendMode.title"
              }
            }
          ],
          "subagentSections": []
        },
        "scope": "account",
        "target": {
          "agent": "codex",
          "kind": "agent"
        },
        "title": {
          "fallback": "Codex",
          "key": "settingsAgents.plugins.codex.title"
        },
        "version": 1
      }
    ],
    "systemTools": [
      {
        "executableNames": [
          "codex"
        ],
        "id": "codex-cli",
        "title": "OpenAI Codex CLI"
      }
    ],
    "targetedPluginContributions": [],
    "tools": [],
    "transcriptActivities": [],
    "ui": {
      "renderers": [],
      "settingsGroups": [],
      "settingsPages": [],
      "translations": [
        {
          "locale": "en",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime (Experimental)",
            "settingsVoice.mode.codexRealtimeSubtitle": "Speak directly with the active Codex agent session."
          }
        },
        {
          "locale": "ru",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime (экспериментально)",
            "settingsVoice.mode.codexRealtimeSubtitle": "Говорите напрямую с активной сессией агента Codex."
          }
        },
        {
          "locale": "pl",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime (eksperymentalne)",
            "settingsVoice.mode.codexRealtimeSubtitle": "Rozmawiaj bezpośrednio z aktywną sesją agenta Codex."
          }
        },
        {
          "locale": "es",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime (experimental)",
            "settingsVoice.mode.codexRealtimeSubtitle": "Habla directamente con la sesión activa del agente Codex."
          }
        },
        {
          "locale": "fr",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime (expérimental)",
            "settingsVoice.mode.codexRealtimeSubtitle": "Parlez directement avec la session active de l’agent Codex."
          }
        },
        {
          "locale": "it",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime (sperimentale)",
            "settingsVoice.mode.codexRealtimeSubtitle": "Parla direttamente con la sessione attiva dell’agente Codex."
          }
        },
        {
          "locale": "pt",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime (experimental)",
            "settingsVoice.mode.codexRealtimeSubtitle": "Fale diretamente com a sessão ativa do agente Codex."
          }
        },
        {
          "locale": "ca",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime (experimental)",
            "settingsVoice.mode.codexRealtimeSubtitle": "Parla directament amb la sessió activa de l’agent Codex."
          }
        },
        {
          "locale": "zh-Hans",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex 实时模式（实验性）",
            "settingsVoice.mode.codexRealtimeSubtitle": "直接与当前 Codex 智能体会话交谈。"
          }
        },
        {
          "locale": "zh-Hant",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex 即時模式（實驗性）",
            "settingsVoice.mode.codexRealtimeSubtitle": "直接與目前的 Codex 代理程式工作階段交談。"
          }
        },
        {
          "locale": "ja",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Realtime（実験的）",
            "settingsVoice.mode.codexRealtimeSubtitle": "アクティブな Codex エージェントセッションと直接会話します。"
          }
        }
      ],
      "views": []
    },
    "voiceModelPacks": [],
    "voiceProviders": [
      {
        "capabilities": {
          "tools": {
            "effectCalls": "none"
          },
          "turn": {
            "bargeIn": false,
            "cancelResponse": false
          }
        },
        "client": {
          "artifactId": "voice-runtime-web",
          "exportName": "activate",
          "modulePath": "./ui/voice"
        },
        "execution": {
          "agent": "codex",
          "kind": "experimental_agent_session_realtime"
        },
        "id": "realtime-codex",
        "kind": "conversation",
        "platforms": [
          "web",
          "ios",
          "android"
        ],
        "roles": [
          "conversation_stt",
          "conversation_tts",
          "realtime_conversation",
          "turn_control"
        ],
        "settings": {
          "connectedServicesBinding": {
            "agent": "codex",
            "description": "Connected Service account used by global Codex Voice sessions.",
            "id": "globalConnectedServices",
            "serviceIds": [
              "openai-codex"
            ],
            "title": "Codex account"
          },
          "fields": [],
          "privacyDisclosure": {
            "fallback": "Audio and the Codex Live conversation are sent from this device to OpenAI using WebRTC. The selected Codex session and Connected Services account run through the selected machine. OpenAI may receive bounded startup and session context and delegated Codex results so the conversation can continue and responses can be spoken. Happier’s server and relay do not carry Codex Live audio; the Happier daemon/app-server still carries signaling, session lifecycle, delegation, tools, and permission control. Provider-operated network relays may participate. Codex or OpenAI may retain developer instructions, realtime conversation material, and related diagnostics in provider-native runtime storage according to the selected account and provider policies; Happier does not delete or rewrite that provider-native data.",
            "key": "settingsVoice.realtimeProviders.codex.privacyDisclosure"
          },
          "schemaVersion": 2
        },
        "title": "Codex Realtime Voice — Experimental"
      }
    ],
    "webhooks": []
  },
  "description": "OpenAI Codex coding agent.",
  "displayName": "Codex",
  "engines": {
    "happier": "^0.0.0"
  },
  "entrypoints": {
    "daemon": "./.happier-plugin/daemon.js"
  },
  "hostAccess": {
    "optional": [],
    "required": [
      {
        "capability": "filesystem",
        "id": "codex-workspace",
        "reason": "Use the admitted Agent workspace as the Codex process working directory.",
        "scope": {
          "access": [
            "read"
          ],
          "locations": [
            {
              "root": "workspace"
            }
          ]
        }
      },
      {
        "capability": "process",
        "id": "codex-process",
        "reason": "Run the declared Codex executable.",
        "scope": {
          "envKeys": [
            "CODEX_HOME",
            "CODEX_SQLITE_HOME"
          ],
          "executables": [
            {
              "id": "codex-cli",
              "kind": "systemTool"
            },
            {
              "id": "codex-acp",
              "kind": "managedDependency"
            }
          ]
        }
      },
      {
        "capability": "network",
        "id": "openai-codex-oauth",
        "reason": "Exchange and refresh OpenAI Codex OAuth credentials for the exact Connected Account.",
        "scope": {
          "methods": [
            "POST"
          ],
          "targets": [
            {
              "kind": "fixedOrigin",
              "origin": "https://auth.openai.com"
            },
            {
              "kind": "connectedAccountOrigin",
              "service": "openai-codex"
            }
          ]
        }
      },
      {
        "capability": "network",
        "id": "openai-codex-quota",
        "reason": "Read quota for the exact OpenAI Codex Connected Account.",
        "scope": {
          "methods": [
            "GET"
          ],
          "targets": [
            {
              "kind": "fixedOrigin",
              "origin": "https://chatgpt.com"
            },
            {
              "kind": "connectedAccountOrigin",
              "service": "openai-codex"
            }
          ]
        }
      }
    ]
  },
  "id": "happier.agent.codex",
  "runtime": {
    "apiVersion": 1
  },
  "schemaVersion": 2,
  "secrets": [],
  "version": "0.0.0"
} as const,
);

const ELEVENLABS_BUNDLED_PLUGIN_MANIFEST = Object.freeze(
{
  "contributes": {
    "accountCollections": [],
    "actions": [],
    "agents": [],
    "backgroundServices": [],
    "browserActions": [],
    "browserTargets": [],
    "commands": [],
    "composerAttachments": [],
    "composerControls": [],
    "composerReferences": [],
    "composerRegions": [],
    "connectedAccountDescriptors": [],
    "daemonDatabases": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [],
    "managedDependencies": [],
    "mcp": {
      "discoverySources": [],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "sessionHeaderActions": [],
    "sessionInfoSections": [],
    "settings": [],
    "systemTools": [],
    "targetedPluginContributions": [],
    "tools": [],
    "transcriptActivities": [],
    "ui": {
      "renderers": [],
      "settingsGroups": [],
      "settingsPages": [],
      "translations": [
        {
          "locale": "en",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing."
          }
        },
        {
          "locale": "ru",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "Аудио и содержимое разговора отправляются с этого устройства в ElevenLabs через клиентское подключение ElevenLabs. В зависимости от выбранной настройки Happier также может отправлять в ElevenLabs ограниченные инструкции агента, определения и результаты клиентских инструментов, а также запросы аутентификации или подготовки, необходимые для функции. Сервер Happier может участвовать в размещённой аутентификации и учёте использования, но ни сервер Happier, ни ретранслятор не передают аудио живого разговора. ElevenLabs может обрабатывать и хранить полученные данные в соответствии с настройками вашей учётной записи ElevenLabs и его условиями. Элементы управления обменом голосовым контекстом отделены от обработки этим провайдером."
          }
        },
        {
          "locale": "pl",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "Dźwięk i treść rozmowy są wysyłane z tego urządzenia do ElevenLabs przez połączenie klienta ElevenLabs. W zależności od wybranej konfiguracji Happier może również wysyłać do ElevenLabs ograniczone instrukcje agenta, definicje i wyniki narzędzi klienckich oraz żądania uwierzytelniania lub provisioningu wymagane przez tę funkcję. Serwer Happier może uczestniczyć w hostowanym uwierzytelnianiu i rozliczaniu użycia, ale ani serwer Happier, ani przekaźnik nie przesyłają dźwięku rozmowy na żywo. ElevenLabs może przetwarzać i przechowywać otrzymane dane zgodnie z ustawieniami Twojego konta ElevenLabs i jego warunkami. Kontrolki udostępniania kontekstu głosowego są odrębne od przetwarzania przez tego dostawcę."
          }
        },
        {
          "locale": "es",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "El audio y el contenido de la conversación se envían desde este dispositivo a ElevenLabs mediante la conexión del cliente de ElevenLabs. Según la configuración seleccionada, Happier también puede enviar a ElevenLabs instrucciones acotadas del agente, definiciones y resultados de herramientas del cliente, y solicitudes de autenticación o aprovisionamiento necesarias para la función. El servidor de Happier puede participar en la autenticación alojada y la contabilidad de uso, pero ni el servidor de Happier ni el relé transportan el audio de la conversación en directo. ElevenLabs puede procesar y conservar los datos recibidos según la configuración y los términos de tu cuenta de ElevenLabs. Los controles para compartir el contexto de voz son independientes del procesamiento por este proveedor."
          }
        },
        {
          "locale": "fr",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "L’audio et le contenu de la conversation sont envoyés depuis cet appareil à ElevenLabs via la connexion cliente d’ElevenLabs. Selon la configuration choisie, Happier peut également envoyer à ElevenLabs des instructions d’agent limitées, des définitions et résultats d’outils côté client, ainsi que les demandes d’authentification ou de provisionnement nécessaires à cette fonctionnalité. Le serveur Happier peut participer à l’authentification hébergée et à la comptabilisation de l’utilisation, mais ni le serveur Happier ni le relais ne transportent l’audio de la conversation en direct. ElevenLabs peut traiter et conserver les données reçues selon les paramètres et les conditions de votre compte ElevenLabs. Les contrôles de partage du contexte vocal sont distincts du traitement par ce fournisseur."
          }
        },
        {
          "locale": "it",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a ElevenLabs tramite la connessione client di ElevenLabs. A seconda della configurazione selezionata, Happier può anche inviare a ElevenLabs istruzioni limitate per l’agente, definizioni e risultati degli strumenti client e richieste di autenticazione o provisioning necessarie per la funzione. Il server di Happier può partecipare all’autenticazione ospitata e alla contabilizzazione dell’utilizzo, ma né il server di Happier né il relay trasportano l’audio della conversazione in diretta. ElevenLabs può elaborare e conservare i dati ricevuti secondo le impostazioni e i termini del tuo account ElevenLabs. I controlli di condivisione del contesto vocale sono separati dall’elaborazione di questo provider."
          }
        },
        {
          "locale": "pt",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "O áudio e o conteúdo da conversa são enviados deste dispositivo para a ElevenLabs através da ligação do cliente ElevenLabs. Consoante a configuração selecionada, a Happier também pode enviar à ElevenLabs instruções limitadas do agente, definições e resultados de ferramentas do cliente e pedidos de autenticação ou aprovisionamento necessários para a funcionalidade. O servidor da Happier pode participar na autenticação alojada e na contabilização de utilização, mas nem o servidor da Happier nem o relay transportam o áudio da conversa em direto. A ElevenLabs pode processar e reter os dados recebidos de acordo com as definições e os termos da sua conta ElevenLabs. Os controlos de partilha de contexto de voz são separados do processamento por este fornecedor."
          }
        },
        {
          "locale": "ca",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a ElevenLabs mitjançant la connexió del client d’ElevenLabs. Segons la configuració seleccionada, Happier també pot enviar a ElevenLabs instruccions limitades de l’agent, definicions i resultats d’eines del client, i sol·licituds d’autenticació o aprovisionament necessàries per a la funció. El servidor de Happier pot participar en l’autenticació allotjada i la comptabilització d’ús, però ni el servidor de Happier ni el relé transporten l’àudio de la conversa en directe. ElevenLabs pot processar i conservar les dades rebudes segons la configuració i les condicions del vostre compte d’ElevenLabs. Els controls per compartir el context de veu són independents del processament per aquest proveïdor."
          }
        },
        {
          "locale": "de",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "Audio und Gesprächsinhalte werden von diesem Gerät über die ElevenLabs-Clientverbindung an ElevenLabs gesendet. Abhängig von der ausgewählten Einrichtung kann Happier außerdem begrenzte Agentenanweisungen, Client-Tool-Definitionen und -Ergebnisse sowie für die Funktion erforderliche Authentifizierungs- oder Bereitstellungsanfragen an ElevenLabs senden. Der Happier-Server kann an gehosteter Authentifizierung und Nutzungsabrechnung beteiligt sein, aber weder der Happier-Server noch das Relay übertragen Live-Gesprächsaudio. ElevenLabs kann empfangene Daten gemäß den Einstellungen und Bedingungen Ihres ElevenLabs-Kontos verarbeiten und speichern. Steuerelemente zur Freigabe des Sprachkontexts sind von der Verarbeitung durch diesen Anbieter getrennt."
          }
        },
        {
          "locale": "zh-Hans",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "音频和对话内容会通过 ElevenLabs 客户端连接从此设备发送到 ElevenLabs。根据所选设置，Happier 还可能向 ElevenLabs 发送受限的代理指令、客户端工具定义和结果，以及此功能所需的身份验证或预配请求。Happier 服务器可能参与托管身份验证和使用情况核算，但 Happier 服务器和中继均不传输实时对话音频。ElevenLabs 可能会根据您的 ElevenLabs 帐户设置和其条款处理并保留收到的数据。语音上下文共享控件独立于此提供商的处理。"
          }
        },
        {
          "locale": "zh-Hant",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "音訊和對話內容會透過 ElevenLabs 用戶端連線從此裝置傳送至 ElevenLabs。根據所選設定，Happier 也可能向 ElevenLabs 傳送受限的代理程式指示、用戶端工具定義和結果，以及此功能所需的驗證或佈建請求。Happier 伺服器可能參與代管驗證和使用量核算，但 Happier 伺服器和轉送均不傳輸即時對話音訊。ElevenLabs 可能會根據您的 ElevenLabs 帳戶設定和其條款處理並保留收到的資料。語音脈絡共用控制項獨立於此提供者的處理。"
          }
        },
        {
          "locale": "ja",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "音声と会話内容は、このデバイスから ElevenLabs クライアント接続を通じて ElevenLabs に送信されます。選択した設定に応じて、Happier は限定されたエージェント指示、クライアントツールの定義と結果、およびこの機能に必要な認証またはプロビジョニング要求も ElevenLabs に送信することがあります。Happier のサーバーはホスト型認証と使用量計測に関与する場合がありますが、Happier のサーバーもリレーもライブ会話音声を転送しません。ElevenLabs は、受信したデータをお客様の ElevenLabs アカウント設定およびその規約に従って処理・保持する場合があります。音声コンテキスト共有の制御は、このプロバイダーによる処理とは別です。"
          }
        }
      ],
      "views": []
    },
    "voiceModelPacks": [],
    "voiceProviders": [
      {
        "capabilities": {
          "tools": {
            "effectCalls": "none"
          },
          "turn": {
            "bargeIn": false,
            "cancelResponse": false,
            "exactMessage": true,
            "interruptionPolicy": "disabled"
          }
        },
        "client": {
          "artifactId": "voice-runtime",
          "exportName": "activate",
          "modulePath": "./ui/voice"
        },
        "credentials": {
          "hostMediated": {
            "operations": [
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "signed-url",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "agentId",
                      "target": {
                        "kind": "query",
                        "name": "agent_id"
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "agentId": {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "required": [
                      "agentId"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.client-auth.signed-url",
                "request": {
                  "bodyTemplate": {
                    "kind": "none"
                  },
                  "contentTypes": [],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 0,
                  "method": "GET",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/conversation/get-signed-url",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 32768
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "conversation-token",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "agentId",
                      "target": {
                        "kind": "query",
                        "name": "agent_id"
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "agentId": {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "required": [
                      "agentId"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.client-auth.sdk-token",
                "request": {
                  "bodyTemplate": {
                    "kind": "none"
                  },
                  "contentTypes": [],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 0,
                  "method": "GET",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/conversation/token",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 32768
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "voices",
                "parameters": {
                  "mapping": [],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {},
                    "type": "object"
                  }
                },
                "purpose": "voice.catalog.voices",
                "request": {
                  "bodyTemplate": {
                    "kind": "none"
                  },
                  "contentTypes": [],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 0,
                  "method": "GET",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/voices",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "agents",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "cursor",
                      "target": {
                        "kind": "query",
                        "name": "cursor"
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "cursor": {
                        "maxLength": 512,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "type": "object"
                  }
                },
                "purpose": "voice.provision.agents.list",
                "request": {
                  "bodyTemplate": {
                    "kind": "none"
                  },
                  "contentTypes": [],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 0,
                  "method": "GET",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/agents",
                  "queryTemplate": [
                    {
                      "name": "page_size",
                      "value": "50"
                    },
                    {
                      "name": "search",
                      "value": "Happier Voice"
                    }
                  ],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "agent",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "agentId",
                      "target": {
                        "encoding": "uri_component",
                        "kind": "path",
                        "placeholder": "agentId"
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "agentId": {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "required": [
                      "agentId"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.provision.agent.get",
                "request": {
                  "bodyTemplate": {
                    "kind": "none"
                  },
                  "contentTypes": [],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 0,
                  "method": "GET",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/agents/{agentId}",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "tools",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "cursor",
                      "target": {
                        "kind": "query",
                        "name": "cursor"
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "cursor": {
                        "maxLength": 512,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "type": "object"
                  }
                },
                "purpose": "voice.provision.tools.list",
                "request": {
                  "bodyTemplate": {
                    "kind": "none"
                  },
                  "contentTypes": [],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 0,
                  "method": "GET",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/tools",
                  "queryTemplate": [
                    {
                      "name": "page_size",
                      "value": "100"
                    }
                  ],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "mutation",
                "id": "create-tool",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "body",
                      "target": {
                        "kind": "body",
                        "pointer": ""
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "body": {
                        "additionalProperties": true,
                        "type": "object"
                      }
                    },
                    "required": [
                      "body"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.provision.tool.create",
                "request": {
                  "bodyTemplate": {
                    "kind": "json",
                    "value": {}
                  },
                  "contentTypes": [
                    "application/json"
                  ],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    },
                    {
                      "name": "content-type",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 524288,
                  "method": "POST",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/tools",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "mutation",
                "id": "delete-tool",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "toolId",
                      "target": {
                        "encoding": "uri_component",
                        "kind": "path",
                        "placeholder": "toolId"
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "toolId": {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "required": [
                      "toolId"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.provision.tool.delete",
                "request": {
                  "bodyTemplate": {
                    "kind": "none"
                  },
                  "contentTypes": [],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 0,
                  "method": "DELETE",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/tools/{toolId}",
                  "queryTemplate": [
                    {
                      "name": "force",
                      "value": "false"
                    }
                  ],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "mutation",
                "id": "create-agent",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "body",
                      "target": {
                        "kind": "body",
                        "pointer": ""
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "body": {
                        "additionalProperties": true,
                        "type": "object"
                      }
                    },
                    "required": [
                      "body"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.provision.agent.create",
                "request": {
                  "bodyTemplate": {
                    "kind": "json",
                    "value": {}
                  },
                  "contentTypes": [
                    "application/json"
                  ],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    },
                    {
                      "name": "content-type",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 524288,
                  "method": "POST",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/agents/create",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "mutation",
                "id": "update-agent",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "agentId",
                      "target": {
                        "encoding": "uri_component",
                        "kind": "path",
                        "placeholder": "agentId"
                      }
                    },
                    {
                      "parameter": "body",
                      "target": {
                        "kind": "body",
                        "pointer": ""
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "agentId": {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      },
                      "body": {
                        "additionalProperties": true,
                        "type": "object"
                      }
                    },
                    "required": [
                      "agentId",
                      "body"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.provision.agent.update",
                "request": {
                  "bodyTemplate": {
                    "kind": "json",
                    "value": {}
                  },
                  "contentTypes": [
                    "application/json"
                  ],
                  "credential": {
                    "format": "raw",
                    "kind": "httpHeader",
                    "name": "xi-api-key"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    },
                    {
                      "name": "content-type",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 524288,
                  "method": "PATCH",
                  "origin": "https://api.elevenlabs.io",
                  "pathTemplate": "/v1/convai/agents/{agentId}",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              }
            ]
          },
          "requirement": {
            "kind": "when_setting_equals",
            "settingId": "billingMode",
            "value": "byo"
          },
          "slot": {
            "description": "Used only for BYO conversation authentication, voice catalogs, and explicit agent settings actions.",
            "id": "api_key",
            "purpose": "voice.client-auth.elevenlabs",
            "title": "ElevenLabs API key"
          },
          "sources": [
            {
              "kind": "savedSecret",
              "operationProjections": [
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "signed-url",
                  "phase": "prepare"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "conversation-token",
                  "phase": "prepare"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "voices",
                  "phase": "settings"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "agents",
                  "phase": "settings"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "agent",
                  "phase": "settings"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "tools",
                  "phase": "settings"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "create-tool",
                  "phase": "settings"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "delete-tool",
                  "phase": "settings"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "create-agent",
                  "phase": "settings"
                },
                {
                  "format": "raw",
                  "kind": "recipientCredential",
                  "operation": "update-agent",
                  "phase": "settings"
                }
              ],
              "secretKinds": [
                "apiKey"
              ]
            }
          ]
        },
        "id": "realtime-elevenlabs",
        "kind": "conversation",
        "platforms": [
          "web",
          "ios",
          "android"
        ],
        "roles": [
          "conversation_stt",
          "conversation_tts",
          "realtime_conversation",
          "turn_control"
        ],
        "settings": {
          "actions": [
            {
              "confirmation": {
                "confirmLabel": "Create agent",
                "description": "Creates a Happier Voice agent and its client tools in the selected ElevenLabs account.",
                "kind": "required",
                "title": "Create ElevenLabs agent?"
              },
              "id": "create-agent",
              "patchFieldIds": [
                "agentId"
              ],
              "placement": {
                "fieldId": "agentId",
                "kind": "afterField"
              },
              "title": "Create Happier Voice agent"
            },
            {
              "confirmation": {
                "confirmLabel": "Update agent",
                "description": "Reconciles the configured Happier Voice agent and its client tools in the selected ElevenLabs account.",
                "kind": "required",
                "title": "Update ElevenLabs agent?"
              },
              "enabledWhen": {
                "kind": "setting_nonempty",
                "settingId": "agentId"
              },
              "id": "update-agent",
              "patchFieldIds": [
                "agentId"
              ],
              "placement": {
                "fieldId": "agentId",
                "kind": "afterField"
              },
              "title": "Update Happier Voice agent"
            }
          ],
          "fields": [
            {
              "default": "happier",
              "id": "billingMode",
              "presentation": {
                "control": "select",
                "options": [
                  {
                    "title": "Happier hosted",
                    "value": "happier"
                  },
                  {
                    "title": "Bring your own ElevenLabs account",
                    "value": "byo"
                  }
                ]
              },
              "schema": {
                "enum": [
                  "happier",
                  "byo"
                ],
                "type": "string"
              },
              "title": "Billing mode"
            },
            {
              "default": {
                "modelId": null,
                "voiceId": "hpp4J3VqNfWAUOO0d1Us",
                "voiceSettings": {
                  "similarityBoost": null,
                  "speed": null,
                  "stability": null
                }
              },
              "id": "tts",
              "presentation": {
                "control": "json"
              },
              "schema": {
                "additionalProperties": false,
                "properties": {
                  "modelId": {
                    "anyOf": [
                      {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "voiceId": {
                    "maxLength": 256,
                    "minLength": 1,
                    "type": "string"
                  },
                  "voiceSettings": {
                    "additionalProperties": false,
                    "properties": {
                      "similarityBoost": {
                        "anyOf": [
                          {
                            "maximum": 1,
                            "minimum": 0,
                            "type": "number"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      },
                      "speed": {
                        "anyOf": [
                          {
                            "maximum": 1.2,
                            "minimum": 0.7,
                            "type": "number"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      },
                      "stability": {
                        "anyOf": [
                          {
                            "maximum": 1,
                            "minimum": 0,
                            "type": "number"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    },
                    "required": [
                      "stability",
                      "similarityBoost",
                      "speed"
                    ],
                    "type": "object"
                  }
                },
                "required": [
                  "voiceId",
                  "modelId",
                  "voiceSettings"
                ],
                "type": "object"
              },
              "title": "Text-to-speech configuration"
            },
            {
              "default": "",
              "id": "agentId",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 256,
                "minLength": 0,
                "pattern": "^[A-Za-z0-9_-]*$",
                "type": "string"
              },
              "title": "ElevenLabs Agent ID"
            }
          ],
          "privacyDisclosure": {
            "fallback": "Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.",
            "key": "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure"
          },
          "readiness": [
            {
              "kind": "setting_nonempty",
              "settingId": "agentId",
              "when": {
                "equals": "byo",
                "settingId": "billingMode"
              }
            }
          ],
          "schemaVersion": 2
        },
        "title": "ElevenLabs Voice"
      }
    ],
    "webhooks": []
  },
  "displayName": "ElevenLabs Voice",
  "engines": {
    "happier": "^0.0.0"
  },
  "hostAccess": {
    "optional": [],
    "required": []
  },
  "id": "happier.voice.elevenlabs",
  "runtime": {
    "apiVersion": 1
  },
  "schemaVersion": 2,
  "secrets": [],
  "version": "0.0.0"
} as const,
);

const OPENAI_BUNDLED_PLUGIN_MANIFEST = Object.freeze(
{
  "contributes": {
    "accountCollections": [],
    "actions": [],
    "agents": [],
    "backgroundServices": [],
    "browserActions": [],
    "browserTargets": [],
    "commands": [],
    "composerAttachments": [],
    "composerControls": [],
    "composerReferences": [],
    "composerRegions": [],
    "connectedAccountDescriptors": [
      {
        "authentication": {
          "defaultModeId": "api-key",
          "modes": [
            {
              "fields": [
                {
                  "id": "token",
                  "schema": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "secret": true,
                  "title": "OpenAI API key"
                }
              ],
              "id": "api-key",
              "kind": "manual",
              "outcomeReconciliation": "none"
            }
          ]
        },
        "id": "openai",
        "title": "OpenAI API key"
      }
    ],
    "daemonDatabases": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [],
    "managedDependencies": [],
    "mcp": {
      "discoverySources": [],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "sessionHeaderActions": [],
    "sessionInfoSections": [],
    "settings": [],
    "systemTools": [],
    "targetedPluginContributions": [],
    "tools": [],
    "transcriptActivities": [],
    "ui": {
      "renderers": [],
      "settingsGroups": [],
      "settingsPages": [],
      "translations": [],
      "views": []
    },
    "voiceModelPacks": [],
    "voiceProviders": [
      {
        "capabilities": {
          "tools": {
            "effectCalls": "stable_ids"
          },
          "turn": {
            "bargeIn": true,
            "cancelResponse": true
          }
        },
        "client": {
          "artifactId": "voice-runtime-web",
          "exportName": "activate",
          "modulePath": "./ui/voice"
        },
        "credentials": {
          "hostMediated": {
            "operations": [
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "client-auth",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "body",
                      "target": {
                        "kind": "body",
                        "pointer": ""
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "body": {
                        "additionalProperties": true,
                        "type": "object"
                      }
                    },
                    "required": [
                      "body"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.client-auth",
                "request": {
                  "bodyTemplate": {
                    "kind": "json",
                    "value": {}
                  },
                  "contentTypes": [
                    "application/json"
                  ],
                  "credential": {
                    "format": "bearer",
                    "kind": "httpHeader",
                    "name": "authorization"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    },
                    {
                      "name": "content-type",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 65536,
                  "method": "POST",
                  "origin": "https://api.openai.com",
                  "pathTemplate": "/v1/realtime/client_secrets",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 65536
                }
              }
            ]
          },
          "requirement": {
            "kind": "always"
          },
          "slot": {
            "description": "Credential used to mint short-lived OpenAI Realtime client authentication.",
            "id": "api_key",
            "purpose": "voice.client-auth",
            "title": "OpenAI credential"
          },
          "sources": [
            {
              "kind": "savedSecret",
              "operationProjections": [
                {
                  "format": "bearer",
                  "kind": "recipientCredential",
                  "operation": "client-auth",
                  "phase": "prepare"
                }
              ],
              "secretKinds": [
                "apiKey"
              ]
            },
            {
              "kind": "connectedAccount",
              "operationProjections": [
                {
                  "allowedHeaderNames": [
                    "authorization"
                  ],
                  "kind": "materializedHttpHeaders",
                  "operation": "client-auth",
                  "phase": "prepare",
                  "request": {
                    "headerNames": [
                      "authorization"
                    ],
                    "kind": "httpHeaders",
                    "origin": "https://api.openai.com"
                  }
                }
              ],
              "service": {
                "localId": "openai",
                "pluginId": "happier.voice.openai"
              }
            },
            {
              "kind": "connectedAccount",
              "operationProjections": [
                {
                  "allowedHeaderNames": [
                    "authorization",
                    "chatgpt-account-id"
                  ],
                  "kind": "materializedHttpHeaders",
                  "operation": "client-auth",
                  "phase": "prepare",
                  "request": {
                    "headerNames": [
                      "authorization",
                      "chatgpt-account-id"
                    ],
                    "kind": "httpHeaders",
                    "origin": "https://api.openai.com"
                  }
                }
              ],
              "service": {
                "localId": "openai-codex",
                "pluginId": "happier.agent.codex"
              }
            }
          ]
        },
        "id": "realtime-openai",
        "kind": "conversation",
        "platforms": [
          "web",
          "ios",
          "android"
        ],
        "roles": [
          "conversation_stt",
          "conversation_tts",
          "realtime_conversation",
          "turn_control"
        ],
        "settings": {
          "fields": [
            {
              "default": {
                "id": "gpt-realtime-2.1",
                "kind": "pinned"
              },
              "id": "model",
              "presentation": {
                "control": "json"
              },
              "schema": {
                "oneOf": [
                  {
                    "additionalProperties": false,
                    "properties": {
                      "id": {
                        "maxLength": 128,
                        "minLength": 1,
                        "type": "string"
                      },
                      "kind": {
                        "const": "pinned"
                      }
                    },
                    "required": [
                      "kind",
                      "id"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "id": {
                        "const": "gpt-realtime"
                      },
                      "kind": {
                        "const": "moving_alias"
                      }
                    },
                    "required": [
                      "kind",
                      "id"
                    ],
                    "type": "object"
                  }
                ],
                "type": "object"
              },
              "title": "Model"
            },
            {
              "default": "marin",
              "id": "voice",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 128,
                "minLength": 1,
                "type": "string"
              },
              "title": "Voice"
            },
            {
              "default": "",
              "id": "instructions",
              "presentation": {
                "control": "textarea"
              },
              "schema": {
                "maxLength": 10000,
                "type": "string"
              },
              "title": "Instructions"
            },
            {
              "default": "server_vad",
              "id": "turnDetection",
              "presentation": {
                "control": "select",
                "options": [
                  {
                    "title": "Server voice activity detection",
                    "value": "server_vad"
                  },
                  {
                    "title": "Semantic voice activity detection",
                    "value": "semantic_vad"
                  },
                  {
                    "title": "Manual",
                    "value": "manual"
                  }
                ]
              },
              "schema": {
                "enum": [
                  "server_vad",
                  "semantic_vad",
                  "manual"
                ],
                "type": "string"
              },
              "title": "Turn detection"
            },
            {
              "default": "",
              "id": "inputTranscriptionModel",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 128,
                "type": "string"
              },
              "title": "Input transcription model"
            }
          ],
          "privacyDisclosure": {
            "fallback": "Audio and conversation content are sent from this device to OpenAI using WebRTC. When enabled or used, OpenAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the selected Saved Voice API key, OpenAI Connected Service, or experimental Codex OAuth account to mint short-lived client authentication; connected accounts are accessed through the selected machine. OpenAI processes the live conversation under the selected account and may retain received data according to that account’s settings and OpenAI’s terms. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.",
            "key": "settingsVoice.realtimeProviders.openai.privacyDisclosure"
          },
          "schemaVersion": 1
        },
        "title": "OpenAI Realtime Voice"
      }
    ],
    "webhooks": []
  },
  "displayName": "OpenAI Realtime Voice",
  "engines": {
    "happier": "^0.0.0"
  },
  "entrypoints": {
    "daemon": "./.happier-plugin/daemon.js"
  },
  "hostAccess": {
    "optional": [],
    "required": []
  },
  "id": "happier.voice.openai",
  "runtime": {
    "apiVersion": 1
  },
  "schemaVersion": 2,
  "secrets": [],
  "version": "0.0.0"
} as const,
);

const XAI_BUNDLED_PLUGIN_MANIFEST = Object.freeze(
{
  "contributes": {
    "accountCollections": [],
    "actions": [],
    "agents": [],
    "backgroundServices": [],
    "browserActions": [],
    "browserTargets": [],
    "commands": [],
    "composerAttachments": [],
    "composerControls": [],
    "composerReferences": [],
    "composerRegions": [],
    "connectedAccountDescriptors": [],
    "daemonDatabases": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [],
    "managedDependencies": [],
    "mcp": {
      "discoverySources": [],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "sessionHeaderActions": [],
    "sessionInfoSections": [],
    "settings": [],
    "systemTools": [],
    "targetedPluginContributions": [],
    "tools": [],
    "transcriptActivities": [],
    "ui": {
      "renderers": [],
      "settingsGroups": [],
      "settingsPages": [],
      "translations": [],
      "views": []
    },
    "voiceModelPacks": [],
    "voiceProviders": [
      {
        "capabilities": {
          "tools": {
            "effectCalls": "stable_ids"
          },
          "turn": {
            "bargeIn": true,
            "cancelResponse": true,
            "clearInput": true,
            "exactMessage": true,
            "interruptionPolicy": "provider_immediate",
            "replay": "stable_ids",
            "resumption": "resume"
          }
        },
        "client": {
          "artifactId": "voice-runtime-web",
          "exportName": "activate",
          "modulePath": "./ui/voice"
        },
        "credentials": {
          "hostMediated": {
            "operations": [
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "client-auth",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "body",
                      "target": {
                        "kind": "body",
                        "pointer": ""
                      }
                    }
                  ],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {
                      "body": {
                        "additionalProperties": true,
                        "type": "object"
                      }
                    },
                    "required": [
                      "body"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.client-auth",
                "request": {
                  "bodyTemplate": {
                    "kind": "json",
                    "value": {}
                  },
                  "contentTypes": [
                    "application/json"
                  ],
                  "credential": {
                    "format": "bearer",
                    "kind": "httpHeader",
                    "name": "authorization"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    },
                    {
                      "name": "content-type",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 65536,
                  "method": "POST",
                  "origin": "https://api.x.ai",
                  "pathTemplate": "/v1/realtime/client_secrets",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              },
              {
                "credentialSlotId": "api_key",
                "effect": "read",
                "id": "voices",
                "parameters": {
                  "mapping": [],
                  "schema": {
                    "additionalProperties": false,
                    "properties": {},
                    "type": "object"
                  }
                },
                "purpose": "voice.catalog.voices",
                "request": {
                  "bodyTemplate": {
                    "kind": "none"
                  },
                  "contentTypes": [],
                  "credential": {
                    "format": "bearer",
                    "kind": "httpHeader",
                    "name": "authorization"
                  },
                  "headerTemplate": [
                    {
                      "name": "accept",
                      "value": "application/json"
                    }
                  ],
                  "maxBodyBytes": 0,
                  "method": "GET",
                  "origin": "https://api.x.ai",
                  "pathTemplate": "/v1/tts/voices",
                  "queryTemplate": [],
                  "redirect": "error"
                },
                "response": {
                  "contentTypes": [
                    "application/json"
                  ],
                  "maxBytes": 2097152
                }
              }
            ]
          },
          "requirement": {
            "kind": "always"
          },
          "slot": {
            "description": "Used only for short-lived client authentication and the xAI voice catalog.",
            "id": "api_key",
            "purpose": "voice.client-auth",
            "title": "xAI API key"
          },
          "sources": [
            {
              "kind": "savedSecret",
              "operationProjections": [
                {
                  "format": "bearer",
                  "kind": "recipientCredential",
                  "operation": "client-auth",
                  "phase": "prepare"
                },
                {
                  "format": "bearer",
                  "kind": "recipientCredential",
                  "operation": "voices",
                  "phase": "settings"
                }
              ],
              "secretKinds": [
                "apiKey"
              ]
            }
          ]
        },
        "id": "realtime-grok",
        "kind": "conversation",
        "platforms": [
          "web",
          "ios",
          "android"
        ],
        "roles": [
          "conversation_stt",
          "conversation_tts",
          "realtime_conversation",
          "turn_control"
        ],
        "settings": {
          "fields": [
            {
              "default": {
                "id": "grok-voice-think-fast-2.0",
                "kind": "pinned"
              },
              "id": "model",
              "presentation": {
                "control": "json"
              },
              "schema": {
                "oneOf": [
                  {
                    "additionalProperties": false,
                    "properties": {
                      "id": {
                        "maxLength": 128,
                        "minLength": 1,
                        "type": "string"
                      },
                      "kind": {
                        "const": "pinned"
                      }
                    },
                    "required": [
                      "kind",
                      "id"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "id": {
                        "const": "grok-voice-latest"
                      },
                      "kind": {
                        "const": "moving_alias"
                      }
                    },
                    "required": [
                      "kind",
                      "id"
                    ],
                    "type": "object"
                  }
                ],
                "type": "object"
              },
              "title": "Model"
            },
            {
              "default": {
                "id": "eve",
                "kind": "catalog"
              },
              "id": "voice",
              "presentation": {
                "control": "json"
              },
              "schema": {
                "oneOf": [
                  {
                    "additionalProperties": false,
                    "properties": {
                      "id": {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      },
                      "kind": {
                        "const": "catalog"
                      }
                    },
                    "required": [
                      "kind",
                      "id"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "id": {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      },
                      "kind": {
                        "const": "custom"
                      }
                    },
                    "required": [
                      "kind",
                      "id"
                    ],
                    "type": "object"
                  }
                ],
                "type": "object"
              },
              "title": "Voice"
            },
            {
              "default": "",
              "id": "instructions",
              "presentation": {
                "control": "textarea"
              },
              "schema": {
                "maxLength": 10000,
                "minLength": 0,
                "type": "string"
              },
              "title": "Instructions"
            },
            {
              "default": "high",
              "id": "reasoningEffort",
              "presentation": {
                "control": "select",
                "options": [
                  {
                    "title": "High",
                    "value": "high"
                  },
                  {
                    "title": "None",
                    "value": "none"
                  }
                ]
              },
              "schema": {
                "enum": [
                  "high",
                  "none"
                ],
                "type": "string"
              },
              "title": "Reasoning effort"
            },
            {
              "default": 1,
              "id": "outputSpeed",
              "presentation": {
                "control": "number",
                "step": 0.05
              },
              "schema": {
                "maximum": 1.5,
                "minimum": 0.7,
                "type": "number"
              },
              "title": "Output speed"
            },
            {
              "default": {
                "keyterms": [],
                "languageHint": null
              },
              "id": "transcription",
              "presentation": {
                "control": "json"
              },
              "schema": {
                "additionalProperties": false,
                "properties": {
                  "keyterms": {
                    "items": {
                      "maxLength": 50,
                      "minLength": 1,
                      "type": "string"
                    },
                    "maxItems": 100,
                    "type": "array"
                  },
                  "languageHint": {
                    "anyOf": [
                      {
                        "enum": [
                          "en",
                          "ar-EG",
                          "ar-SA",
                          "ar-AE",
                          "bn",
                          "zh",
                          "fr",
                          "de",
                          "hi",
                          "id",
                          "it",
                          "ja",
                          "ko",
                          "pt-BR",
                          "pt-PT",
                          "ru",
                          "es-MX",
                          "es-ES",
                          "tr",
                          "vi"
                        ],
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "languageHint",
                  "keyterms"
                ],
                "type": "object"
              },
              "title": "Transcription"
            },
            {
              "default": {
                "idleTimeoutMs": null,
                "mode": "server_vad",
                "prefixPaddingMs": null,
                "silenceDurationMs": null,
                "threshold": null
              },
              "id": "turnDetection",
              "presentation": {
                "control": "json"
              },
              "schema": {
                "additionalProperties": false,
                "properties": {
                  "idleTimeoutMs": {
                    "anyOf": [
                      {
                        "maximum": 600000,
                        "minimum": 1,
                        "type": "integer"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "mode": {
                    "const": "server_vad"
                  },
                  "prefixPaddingMs": {
                    "anyOf": [
                      {
                        "maximum": 10000,
                        "minimum": 0,
                        "type": "integer"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "silenceDurationMs": {
                    "anyOf": [
                      {
                        "maximum": 10000,
                        "minimum": 0,
                        "type": "integer"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "threshold": {
                    "anyOf": [
                      {
                        "maximum": 0.9,
                        "minimum": 0.1,
                        "type": "number"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "mode",
                  "threshold",
                  "silenceDurationMs",
                  "prefixPaddingMs",
                  "idleTimeoutMs"
                ],
                "type": "object"
              },
              "title": "Turn detection"
            },
            {
              "default": false,
              "id": "resumptionEnabled",
              "presentation": {
                "control": "switch"
              },
              "schema": {
                "type": "boolean"
              },
              "title": "Resume recent xAI conversation"
            }
          ],
          "privacyDisclosure": {
            "fallback": "Audio and conversation content are sent from this device to xAI through the xAI Realtime connection. When enabled or used, xAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the xAI API key saved in your Happier account secrets only for the bounded client-auth and voice-catalog operations. xAI processes the live conversation under that account and may retain received data according to the account settings and xAI’s terms. If resumption is enabled, Happier saves the provider conversation ID; forgetting it removes Happier’s saved ID and does not delete data held by xAI. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.",
            "key": "settingsVoice.realtimeProviders.xai.privacyDisclosure"
          },
          "schemaVersion": 1
        },
        "title": "xAI Grok Voice"
      }
    ],
    "webhooks": []
  },
  "displayName": "xAI Grok Voice",
  "engines": {
    "happier": "^0.0.0"
  },
  "hostAccess": {
    "optional": [],
    "required": []
  },
  "id": "happier.voice.xai",
  "runtime": {
    "apiVersion": 1
  },
  "schemaVersion": 2,
  "secrets": [],
  "version": "0.0.0"
} as const,
);

const CODEX_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  CODEX_BUNDLED_PLUGIN_MANIFEST,
  CODEX_BUNDLED_VOICE_ACTIVATE,
);
const ELEVENLABS_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  ELEVENLABS_BUNDLED_PLUGIN_MANIFEST,
  ELEVENLABS_BUNDLED_VOICE_ACTIVATE,
);
const OPENAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  OPENAI_BUNDLED_PLUGIN_MANIFEST,
  OPENAI_BUNDLED_VOICE_ACTIVATE,
);
const XAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(
  XAI_BUNDLED_PLUGIN_MANIFEST,
  XAI_BUNDLED_VOICE_ACTIVATE,
);

export const BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([
  ...CODEX_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
  ...ELEVENLABS_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
  ...OPENAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
  ...XAI_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
]) satisfies readonly BundledConversationRuntimeEntry[];

/**
 * Exact generated first-party entry identities admitted to the hosted
 * conversation service. This is intentionally separate from provider ids and
 * manifest metadata so copied or colliding external entries fail closed.
 */
export const BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([
  ...ELEVENLABS_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,
]) satisfies readonly BundledConversationRuntimeEntry[];
