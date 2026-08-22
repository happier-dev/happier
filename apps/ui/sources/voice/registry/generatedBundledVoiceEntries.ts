/**
 * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-PROJECTION)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Normalized first-party manifest projection plus qualified presentation.
 * Executable activation roots are emitted separately by host platform.
 */

import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';
import type { BundledVoiceManifestContribution } from './bundledVoiceManifestProjection';
import type { VoiceProviderPresentation } from './voiceProviderPresentation';

import { VOICE_PROVIDER_PRESENTATIONS as CODEX_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-codex/ui/voice';
import { VOICE_PROVIDER_PRESENTATIONS as ELEVENLABS_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-elevenlabs/ui/voice';
import { VOICE_PROVIDER_PRESENTATIONS as GOOGLE_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-google/ui/voice';
import { VOICE_PROVIDER_PRESENTATIONS as OPENAI_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-openai/ui/voice';
import { VOICE_PROVIDER_PRESENTATIONS as OPENAI_COMPAT_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-openai-compat/ui/voice';
import { VOICE_PROVIDER_PRESENTATIONS as XAI_VOICE_PROVIDER_PRESENTATIONS } from '@happier-dev/plugins-xai/ui/voice';

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
          ]
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
          "kind": "experimental_agent_session_realtime",
          "supportedRuntimeVersions": [
            "0.145.0",
            "0.146.0"
          ]
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
            "CODEX_HOME"
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
                "id": "update-tool",
                "parameters": {
                  "mapping": [
                    {
                      "parameter": "toolId",
                      "target": {
                        "encoding": "uri_component",
                        "kind": "path",
                        "placeholder": "toolId"
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
                      "body": {
                        "additionalProperties": true,
                        "type": "object"
                      },
                      "toolId": {
                        "maxLength": 256,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "required": [
                      "toolId",
                      "body"
                    ],
                    "type": "object"
                  }
                },
                "purpose": "voice.provision.tool.update",
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
                  "pathTemplate": "/v1/convai/tools/{toolId}",
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
                  "operation": "update-tool",
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
          "privacyDisclosure": "Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.",
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

const GOOGLE_BUNDLED_PLUGIN_MANIFEST = Object.freeze(
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
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "Audio sent for transcription is processed by Google Gemini, and text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms."
          }
        },
        {
          "locale": "ru",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "Аудио, отправленное на транскрипцию, обрабатывается Google Gemini, а текст, отправленный на речь, обрабатывается Google Cloud Text-to-Speech. Happier отправляет эти запросы через выбранную исполнительную машину, используя учетные данные Google API этой машины. Google может сохранять полученные данные в соответствии с настройками выбранной учетной записи Google и условиями Google."
          }
        },
        {
          "locale": "pl",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "Dźwięk przesyłany do transkrypcji jest przetwarzany przez Google Gemini, a tekst przesyłany do mowy jest przetwarzany przez Google Cloud Text-to-Speech. Happier wysyła te żądania za pośrednictwem wybranej maszyny wykonawczej, korzystając z danych uwierzytelniających Google API tej maszyny. Google może zachować otrzymane dane zgodnie z wybranymi ustawieniami konta Google i warunkami Google."
          }
        },
        {
          "locale": "es",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "El audio enviado para transcripción lo procesa Google Gemini y el texto enviado para voz lo procesa Google Cloud Text-to-Speech. Happier envía estas solicitudes a través de la máquina de ejecución seleccionada utilizando la credencial API de Google de esa máquina. Google puede conservar los datos recibidos de acuerdo con la configuración de la cuenta de Google seleccionada y los términos de Google."
          }
        },
        {
          "locale": "fr",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "L'audio envoyé pour transcription est traité par Google Gemini et le texte envoyé pour parole est traité par Google Cloud Text-to-Speech. Happier envoie ces requêtes via la machine de la sélectionnée à l'aide des informations d'identification de l'API Google de cette machine. Google peut conserver les données reçues conformément aux paramètres de la sélection de la compte de Google et aux conditions de Google."
          }
        },
        {
          "locale": "it",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "L'audio inviato per la trascrizione viene elaborato da Google Gemini mentre il testo inviato per la sintesi vocale viene elaborato da Google Cloud Text-to-Speech. Happier invia queste richieste attraverso la macchina di esecuzione selezionata utilizzando le credenziali API di Google di quella macchina. Google può conservare i dati ricevuti in base alle impostazioni dell'account Google selezionato e ai termini di Google."
          }
        },
        {
          "locale": "pt",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "O áudio enviado para transcrição é processado pelo Google Gemini e o texto enviado para fala é processado pelo Google Cloud Text-to-Speech. Happier envia essas solicitações por meio da máquina de execução selecionada usando a credencial da API do Google dessa máquina.O Google pode reter os dados recebidos de acordo com as configurações da conta do Google selecionada e os termos do Google."
          }
        },
        {
          "locale": "ca",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "Google Gemini processa l'àudio enviat per a la transcripció i Google Cloud Text-to-Speech el processa el text enviat per a la veu. Happier envia aquestes sol·licituds a través de la màquina d'execució seleccionada mitjançant la credencial de l'API de Google d'aquesta màquina. Google pot conservar les dades rebudes d'acord amb la configuració del compte de Google seleccionat i els termes de Google."
          }
        },
        {
          "locale": "zh-Hans",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "发送用于转录的音频由 Google Gemini 处理，发送用于语音的文本由 Google Cloud 文本转语音处理。Happier 使用该机器的 Google API 凭证通过选定的执行机器发送这些请求。Google 可能会根据所选 Google 帐户的设置和 Google 条款保留收到的数据。"
          }
        },
        {
          "locale": "zh-Hant",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "發送用於轉錄的音訊由Google Gemini處理，發送用於語音的文字由Google Cloud 文本转语音处理。 Happier使用該機器的Google API認證透過選定的執行機器發送這些請求。 Google可能會根據所選Google帳戶的設定和Google條款保留收到的資料。"
          }
        },
        {
          "locale": "ja",
          "messages": {
            "settingsVoice.realtimeProviders.google.privacyDisclosure": "文字起こしのために送信された音声は Google Gemini によって処理され、音声として送信されたテキストは Google Cloud Text-to-Speech によって処理されます。Happier は、選択した実行マシンの Google API 認証情報を使用して、これらのリクエストをそのマシン経由で送信します。Google は、選択した Google アカウントの設定および Google の規約に従って、受信したデータを保持する場合があります。"
          }
        }
      ],
      "views": []
    },
    "voiceModelPacks": [],
    "voiceProviders": [
      {
        "catalogs": [
          {
            "allowCustom": true,
            "kind": "models",
            "settingFieldId": "model"
          }
        ],
        "credentials": {
          "requirement": {
            "kind": "always"
          },
          "slot": {
            "id": "api_key",
            "purpose": "voice.speech.transcribe",
            "title": "Google Gemini API key"
          },
          "sources": [
            {
              "kind": "savedSecret",
              "rawGrants": [
                {
                  "phase": "speech",
                  "realm": "daemon",
                  "request": {
                    "headerNames": [
                      "x-goog-api-key"
                    ],
                    "kind": "httpHeaders",
                    "origin": "https://generativelanguage.googleapis.com"
                  }
                }
              ],
              "secretKinds": [
                "apiKey"
              ]
            }
          ]
        },
        "id": "gemini-stt",
        "kind": "speech",
        "limits": {
          "transcribe": {
            "maxInputBytes": 8388608
          }
        },
        "platforms": [
          "web",
          "ios",
          "android"
        ],
        "roles": [
          "dictation_stt",
          "conversation_stt"
        ],
        "settings": {
          "fields": [
            {
              "default": "gemini-2.5-flash",
              "id": "model",
              "presentation": {
                "control": "select"
              },
              "schema": {
                "maxLength": 256,
                "minLength": 1,
                "type": "string"
              },
              "title": "Model"
            },
            {
              "default": "",
              "id": "language",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 64,
                "type": "string"
              },
              "title": "Language"
            }
          ],
          "privacyDisclosure": {
            "fallback": "Audio sent for transcription is processed by Google Gemini, and text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.",
            "key": "settingsVoice.realtimeProviders.google.privacyDisclosure"
          },
          "schemaVersion": 2
        },
        "title": "Google Gemini Speech-to-Text"
      },
      {
        "catalogs": [
          {
            "allowCustom": true,
            "kind": "voices",
            "settingFieldId": "voiceName"
          }
        ],
        "credentials": {
          "requirement": {
            "kind": "always"
          },
          "slot": {
            "id": "api_key",
            "purpose": "voice.speech.synthesize",
            "title": "Google Cloud API key"
          },
          "sources": [
            {
              "kind": "savedSecret",
              "rawGrants": [
                {
                  "phase": "speech",
                  "realm": "daemon",
                  "request": {
                    "headerNames": [
                      "x-goog-api-key"
                    ],
                    "kind": "httpHeaders",
                    "origin": "https://texttospeech.googleapis.com"
                  }
                }
              ],
              "secretKinds": [
                "apiKey"
              ]
            }
          ]
        },
        "id": "google-cloud-tts",
        "kind": "speech",
        "limits": {
          "synthesize": {
            "maxInputCharacters": 1666,
            "maxOutputBytes": 3000000
          }
        },
        "platforms": [
          "web",
          "ios",
          "android"
        ],
        "roles": [
          "conversation_tts"
        ],
        "settings": {
          "fields": [
            {
              "default": "",
              "id": "voiceName",
              "presentation": {
                "control": "select"
              },
              "schema": {
                "maxLength": 256,
                "type": "string"
              },
              "title": "Voice"
            },
            {
              "default": "",
              "id": "languageCode",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 64,
                "type": "string"
              },
              "title": "Language"
            },
            {
              "default": "mp3",
              "id": "format",
              "presentation": {
                "control": "select",
                "options": [
                  {
                    "title": "MP3",
                    "value": "mp3"
                  },
                  {
                    "title": "WAV",
                    "value": "wav"
                  }
                ]
              },
              "schema": {
                "enum": [
                  "mp3",
                  "wav"
                ],
                "type": "string"
              },
              "title": "Audio format"
            },
            {
              "default": 1,
              "id": "speakingRate",
              "presentation": {
                "control": "number",
                "step": 0.05
              },
              "schema": {
                "maximum": 4,
                "minimum": 0.25,
                "type": "number"
              },
              "title": "Speaking rate"
            },
            {
              "default": 0,
              "id": "pitch",
              "presentation": {
                "control": "number",
                "step": 0.5
              },
              "schema": {
                "maximum": 20,
                "minimum": -20,
                "type": "number"
              },
              "title": "Pitch"
            }
          ],
          "privacyDisclosure": {
            "fallback": "Audio sent for transcription is processed by Google Gemini, and text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.",
            "key": "settingsVoice.realtimeProviders.google.privacyDisclosure"
          },
          "readiness": [
            {
              "kind": "setting_nonempty",
              "settingId": "voiceName"
            }
          ],
          "schemaVersion": 2
        },
        "title": "Google Cloud Text-to-Speech"
      }
    ],
    "webhooks": []
  },
  "description": "Google Gemini speech-to-text and Google Cloud text-to-speech.",
  "displayName": "Google Voice",
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
  "id": "happier.voice.google",
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

const OPENAI_COMPAT_BUNDLED_PLUGIN_MANIFEST = Object.freeze(
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
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "Audio and text are sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms."
          }
        },
        {
          "locale": "ru",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "Аудио и текст отправляются с выбранной машины выполнения на настроенную вами OpenAI-совместимую конечную точку. Оператор конечной точки может хранить полученные данные в соответствии со своими условиями."
          }
        },
        {
          "locale": "pl",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "Dźwięk i tekst są wysyłane z wybranej maszyny wykonawczej do skonfigurowanego punktu końcowego zgodnego z OpenAI. Operator punktu końcowego może przechowywać otrzymane dane zgodnie z własnymi warunkami."
          }
        },
        {
          "locale": "es",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "El audio y el texto se envían desde la máquina de ejecución seleccionada al punto de conexión compatible con OpenAI que configures. Su operador puede conservar los datos recibidos según sus propias condiciones."
          }
        },
        {
          "locale": "fr",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "L’audio et le texte sont envoyés depuis la machine d’exécution sélectionnée vers le point de terminaison compatible OpenAI que vous configurez. Son opérateur peut conserver les données reçues selon ses propres conditions."
          }
        },
        {
          "locale": "it",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "Audio e testo vengono inviati dalla macchina di esecuzione selezionata all’endpoint compatibile con OpenAI configurato. Il gestore dell’endpoint può conservare i dati ricevuti secondo le proprie condizioni."
          }
        },
        {
          "locale": "pt",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "O áudio e o texto são enviados da máquina de execução selecionada para o endpoint compatível com OpenAI que configurar. O operador do endpoint pode conservar os dados recebidos de acordo com os respetivos termos."
          }
        },
        {
          "locale": "ca",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "L’àudio i el text s’envien des de la màquina d’execució seleccionada al punt final compatible amb OpenAI que configuris. L’operador del punt final pot conservar les dades rebudes segons les seves condicions."
          }
        },
        {
          "locale": "zh-Hans",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "音频和文本会从所选执行计算机发送到您配置的 OpenAI 兼容端点。端点运营商可能会根据其自身条款保留收到的数据。"
          }
        },
        {
          "locale": "zh-Hant",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "音訊和文字會從所選執行電腦傳送至您設定的 OpenAI 相容端點。端點營運商可能會依其自身條款保留收到的資料。"
          }
        },
        {
          "locale": "ja",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompat": "音声とテキストは、選択した実行マシンから設定済みの OpenAI 互換エンドポイントへ送信されます。エンドポイントの運営者は、独自の規約に従って受信データを保持する場合があります。"
          }
        }
      ],
      "views": []
    },
    "voiceModelPacks": [],
    "voiceProviders": [
      {
        "credentials": {
          "requirement": {
            "kind": "optional"
          },
          "slot": {
            "id": "api_key",
            "purpose": "voice.speech.transcribe",
            "title": "OpenAI-compatible STT API key"
          },
          "sources": [
            {
              "kind": "savedSecret",
              "rawGrants": [
                {
                  "phase": "speech",
                  "realm": "daemon",
                  "request": {
                    "keys": [
                      "HAPPIER_VOICE_OPENAI_COMPAT_STT_API_KEY"
                    ],
                    "kind": "environment"
                  }
                }
              ],
              "secretKinds": [
                "apiKey"
              ]
            }
          ]
        },
        "id": "stt",
        "kind": "speech",
        "limits": {
          "transcribe": {
            "maxInputBytes": 8388608
          }
        },
        "platforms": [
          "web",
          "ios",
          "android"
        ],
        "roles": [
          "dictation_stt",
          "conversation_stt"
        ],
        "settings": {
          "fields": [
            {
              "default": "",
              "id": "baseUrl",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 2048,
                "minLength": 0,
                "type": "string"
              },
              "title": "Transcription endpoint"
            },
            {
              "default": "",
              "id": "insecureLocalOriginConsent",
              "presentation": {
                "control": "text",
                "hidden": true
              },
              "schema": {
                "maxLength": 512,
                "minLength": 0,
                "type": "string"
              },
              "title": "Confirmed insecure local origin"
            },
            {
              "default": "",
              "id": "insecureLocalConsentMachineId",
              "presentation": {
                "control": "text",
                "hidden": true
              },
              "schema": {
                "maxLength": 512,
                "minLength": 0,
                "type": "string"
              },
              "title": "Confirmed insecure local machine"
            },
            {
              "default": "whisper-1",
              "id": "model",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 256,
                "minLength": 1,
                "type": "string"
              },
              "title": "Model"
            },
            {
              "default": "",
              "id": "language",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 64,
                "minLength": 0,
                "type": "string"
              },
              "title": "Language"
            }
          ],
          "privacyDisclosure": {
            "fallback": "Audio and text are sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.",
            "key": "settingsVoice.realtimeProviders.speechProcessing.openAiCompat"
          },
          "readiness": [
            {
              "kind": "setting_nonempty",
              "settingId": "baseUrl"
            }
          ],
          "schemaVersion": 2
        },
        "title": "OpenAI-compatible Speech-to-Text"
      },
      {
        "credentials": {
          "requirement": {
            "kind": "optional"
          },
          "slot": {
            "id": "api_key",
            "purpose": "voice.speech.synthesize",
            "title": "OpenAI-compatible TTS API key"
          },
          "sources": [
            {
              "kind": "savedSecret",
              "rawGrants": [
                {
                  "phase": "speech",
                  "realm": "daemon",
                  "request": {
                    "keys": [
                      "HAPPIER_VOICE_OPENAI_COMPAT_TTS_API_KEY"
                    ],
                    "kind": "environment"
                  }
                }
              ],
              "secretKinds": [
                "apiKey"
              ]
            }
          ]
        },
        "id": "tts",
        "kind": "speech",
        "limits": {
          "synthesize": {
            "maxInputCharacters": 200000,
            "maxOutputBytes": 33554432
          }
        },
        "platforms": [
          "web",
          "ios",
          "android"
        ],
        "roles": [
          "conversation_tts"
        ],
        "settings": {
          "fields": [
            {
              "default": "",
              "id": "baseUrl",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 2048,
                "minLength": 0,
                "type": "string"
              },
              "title": "Speech endpoint"
            },
            {
              "default": "",
              "id": "insecureLocalOriginConsent",
              "presentation": {
                "control": "text",
                "hidden": true
              },
              "schema": {
                "maxLength": 512,
                "minLength": 0,
                "type": "string"
              },
              "title": "Confirmed insecure local origin"
            },
            {
              "default": "",
              "id": "insecureLocalConsentMachineId",
              "presentation": {
                "control": "text",
                "hidden": true
              },
              "schema": {
                "maxLength": 512,
                "minLength": 0,
                "type": "string"
              },
              "title": "Confirmed insecure local machine"
            },
            {
              "default": "tts-1",
              "id": "model",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 256,
                "minLength": 1,
                "type": "string"
              },
              "title": "Model"
            },
            {
              "default": "alloy",
              "id": "voiceName",
              "presentation": {
                "control": "text"
              },
              "schema": {
                "maxLength": 256,
                "minLength": 1,
                "type": "string"
              },
              "title": "Voice"
            },
            {
              "default": "mp3",
              "id": "format",
              "presentation": {
                "control": "select",
                "options": [
                  {
                    "title": "MP3",
                    "value": "mp3"
                  },
                  {
                    "title": "WAV",
                    "value": "wav"
                  }
                ]
              },
              "schema": {
                "enum": [
                  "mp3",
                  "wav"
                ],
                "type": "string"
              },
              "title": "Audio format"
            }
          ],
          "privacyDisclosure": {
            "fallback": "Audio and text are sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.",
            "key": "settingsVoice.realtimeProviders.speechProcessing.openAiCompat"
          },
          "readiness": [
            {
              "kind": "setting_nonempty",
              "settingId": "baseUrl"
            }
          ],
          "schemaVersion": 2
        },
        "title": "OpenAI-compatible Text-to-Speech"
      }
    ],
    "webhooks": []
  },
  "description": "Batch speech-to-text and text-to-speech through a selected-machine OpenAI-compatible endpoint.",
  "displayName": "OpenAI-compatible Speech",
  "engines": {
    "happier": "^0.0.0"
  },
  "entrypoints": {
    "daemon": "./.happier-plugin/daemon.js",
    "development": "./src/index.ts"
  },
  "hostAccess": {
    "optional": [],
    "required": []
  },
  "id": "happier.voice.openai-compat",
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
                "id": "grok-voice-think-fast-1.0",
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

export const BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS = Object.freeze([
  ...projectBundledVoiceManifestContributions(CODEX_BUNDLED_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(ELEVENLABS_BUNDLED_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(GOOGLE_BUNDLED_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(OPENAI_BUNDLED_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(OPENAI_COMPAT_BUNDLED_PLUGIN_MANIFEST),
  ...projectBundledVoiceManifestContributions(XAI_BUNDLED_PLUGIN_MANIFEST),
]) satisfies readonly BundledVoiceManifestContribution[];

export const BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS = Object.freeze([
  ...CODEX_VOICE_PROVIDER_PRESENTATIONS,
  ...ELEVENLABS_VOICE_PROVIDER_PRESENTATIONS,
  ...GOOGLE_VOICE_PROVIDER_PRESENTATIONS,
  ...OPENAI_VOICE_PROVIDER_PRESENTATIONS,
  ...OPENAI_COMPAT_VOICE_PROVIDER_PRESENTATIONS,
  ...XAI_VOICE_PROVIDER_PRESENTATIONS,
]) satisfies readonly VoiceProviderPresentation[];
