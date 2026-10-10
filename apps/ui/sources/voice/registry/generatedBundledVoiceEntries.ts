/**
 * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-PROJECTION)
 *
 * This file is emitted by:
 * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`
 *
 * Normalized first-party manifest projection plus qualified presentation.
 * Executable activation roots are emitted separately by host platform.
 */

import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';
import type { BundledVoiceManifestContribution } from './bundledVoiceManifestProjection';
import type { VoiceProviderPresentation } from './voiceProviderPresentation';
import { createBundledVoiceProviderPresentations } from './bundledVoiceManifestProjection';
import { BUNDLED_FIRST_PARTY_VOICE_SELECTION_OPTIONS } from '@happier-dev/protocol/voice/settings/generatedBundledVoiceSelectionOptions';


const CODEX_BUNDLED_PLUGIN_MANIFEST = Object.freeze(
{
  "contributes": {
    "accountCollections": [],
    "actions": [],
    "agents": [
      {
        "capabilities": {
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
              "steer"
            ],
            "executionRunContext": {
              "versions": [
                1
              ]
            },
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
            "usageReporting": true,
            "workspaceWrites": "deny",
            "workStateSources": [
              {
                "id": "goals",
                "itemKinds": [
                  "goal"
                ]
              }
            ]
          },
          "structuredOutput": {
            "formats": [
              "json"
            ]
          },
          "surfaces": [
            "externalSessions"
          ],
          "tools": {
            "delivery": "native_mcp"
          }
        },
        "catalog": {
          "agentCliSystemTool": {
            "toolId": "codex-cli"
          },
          "resumeChecklist": {
            "includeLoginStatus": true
          },
          "vendorResume": {
            "support": "experimental"
          }
        },
        "cli": {
          "auth": {
            "environmentVariables": [
              "OPENAI_API_KEY",
              "CODEX_API_KEY"
            ],
            "loginLaunches": [
              {
                "args": [
                  "login"
                ],
                "kind": "primary"
              }
            ],
            "nonInteractiveStatusProbe": true,
            "support": "login_terminal"
          },
          "commandPolicy": {
            "daemonAutostartDefault": "preferLocalTui"
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
                "maxExpandedBytes": 536870912,
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
            "nativeUpdate": {
              "args": [
                "update"
              ],
              "installPaths": [
                ".codex/packages/standalone"
              ]
            },
            "npmPackageName": "@openai/codex",
            "recommendationOrder": 20
          }
        },
        "connectedAccounts": [
          {
            "credentialKinds": [
              "oauth"
            ],
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
              "writerSafety": "native_prevention"
            },
            "sources": [
              {
                "contentSearch": true,
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
    "captureSources": [],
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
        "recoveryCredits": {
          "supported": true
        },
        "title": "ChatGPT"
      }
    ],
    "daemonDatabases": [],
    "dragSources": [],
    "dropTargets": [],
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
    "inputTypes": [],
    "machineProvisioners": [],
    "managedDependencies": [
      {
        "description": "Codex ACP dependency used by the Codex ACP backend",
        "executable": "codex-acp",
        "id": "codex-acp",
        "sources": [
          {
            "archiveLayout": "single_executable",
            "assetNamePrefix": "codex-acp",
            "distTag": "latest",
            "installId": "dep.codex-acp",
            "kind": "githubReleaseBinary",
            "launch": {
              "configOverrideArgument": "-c",
              "configOverridesEnvironmentKey": "HAPPIER_CODEX_ACP_CONFIG_OVERRIDES",
              "kind": "codexAcp",
              "overrideEnvironmentKey": "HAPPIER_CODEX_ACP_BIN"
            },
            "repo": "zed-industries/codex-acp",
            "targetByPlatform": {
              "darwin-arm64": "aarch64-apple-darwin",
              "darwin-x64": "x86_64-apple-darwin",
              "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
              "linux-arm64-musl": "aarch64-unknown-linux-musl",
              "linux-x64-gnu": "x86_64-unknown-linux-gnu",
              "linux-x64-musl": "x86_64-unknown-linux-musl",
              "win32-arm64": "aarch64-pc-windows-msvc",
              "win32-x64": "x86_64-pc-windows-msvc"
            }
          }
        ],
        "title": "Codex ACP"
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
    "projectNativeAdapters": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "roles": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "searchProviders": [],
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
            "ionName": "terminal"
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
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Speak directly with the active Codex agent session."
          }
        },
        {
          "locale": "de",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Sprich direkt mit der aktiven Codex-Agentensitzung."
          }
        },
        {
          "locale": "ru",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Говорите напрямую с активной сессией агента Codex."
          }
        },
        {
          "locale": "pl",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Rozmawiaj bezpośrednio z aktywną sesją agenta Codex."
          }
        },
        {
          "locale": "es",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Habla directamente con la sesión activa del agente Codex."
          }
        },
        {
          "locale": "fr",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Parlez directement avec la session active de l’agent Codex."
          }
        },
        {
          "locale": "it",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Parla direttamente con la sessione attiva dell’agente Codex."
          }
        },
        {
          "locale": "pt",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Fale diretamente com a sessão ativa do agente Codex."
          }
        },
        {
          "locale": "ca",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "Parla directament amb la sessió activa de l’agent Codex."
          }
        },
        {
          "locale": "zh-Hans",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "直接与当前 Codex 智能体会话交谈。"
          }
        },
        {
          "locale": "zh-Hant",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
            "settingsVoice.mode.codexRealtimeSubtitle": "直接與目前的 Codex 代理程式工作階段交談。"
          }
        },
        {
          "locale": "ja",
          "messages": {
            "agentInput.connectedServiceLabel.codex": "OpenAI Codex",
            "settingsVoice.mode.codexRealtime": "Codex Live",
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
          "exportName": "activate"
        },
        "execution": {
          "agent": "codex",
          "kind": "experimental_agent_session_realtime"
        },
        "id": "realtime-codex",
        "kind": "conversation",
        "mark": {
          "agentId": "codex",
          "kind": "agent"
        },
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
          "privacyFacts": {
            "audioDestination": "OpenAI",
            "processor": "Codex Live · OpenAI",
            "retention": {
              "fallback": "Follows your service account settings and terms.",
              "key": "settingsVoice.pages.privacy.servicePolicy"
            }
          },
          "schemaVersion": 2
        },
        "title": "Codex Realtime Voice — Experimental"
      }
    ],
    "webhooks": [],
    "workflows": []
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
        "reason": "Read quota and consume recovery credits for the exact OpenAI Codex Connected Account.",
        "scope": {
          "methods": [
            "GET",
            "POST"
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
    "agentFactories": [
      {
        "loadMode": "immutable-js",
        "localAgentId": "codex",
        "locator": {
          "export": "createCodexAgentRuntime",
          "externalSessionsExport": "codexExternalSessionsContribution",
          "module": "./agent/runtime/engine",
          "runtimeApiVersion": 1
        },
        "normalizedModulePath": ".happier-plugin/agent/runtime/engine.js"
      }
    ],
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
    "captureSources": [],
    "commands": [],
    "composerAttachments": [],
    "composerControls": [],
    "composerReferences": [],
    "composerRegions": [],
    "connectedAccountDescriptors": [],
    "daemonDatabases": [],
    "dragSources": [],
    "dropTargets": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [],
    "inputTypes": [],
    "machineProvisioners": [],
    "managedDependencies": [],
    "mcp": {
      "discoverySources": [],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "projectNativeAdapters": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "roles": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "searchProviders": [],
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
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "After changing the voice, update your agent so ElevenLabs uses it.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "Agent ID saved. Update after changing the voice.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Filled in when Happier creates your agent.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Create an agent, or enter its ID above.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Happier Voice agent",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Account",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Conversation",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Voice",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "Manage API keys",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Which ElevenLabs voice model speaks. Default suits most voices.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Open your ElevenLabs account",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "How closely it matches the original voice.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "How quickly the voice speaks.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "How steady the voice sounds."
          }
        },
        {
          "locale": "ru",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "После смены голоса обновите агента, чтобы ElevenLabs использовал его.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "ID агента сохранён. Обновите после смены голоса.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Заполняется, когда Happier создаёт вашего агента.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Создайте агента или введите его ID выше.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Голосовой агент Happier",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Аккаунт",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Разговор",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Голос",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "Управление API-ключами",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Какая голосовая модель ElevenLabs говорит. По умолчанию подходит большинству голосов.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Открыть ваш аккаунт ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "Аудио и содержимое разговора отправляются с этого устройства в ElevenLabs через клиентское подключение ElevenLabs. В зависимости от выбранной настройки Happier также может отправлять в ElevenLabs ограниченные инструкции агента, определения и результаты клиентских инструментов, а также запросы аутентификации или подготовки, необходимые для функции. Сервер Happier может участвовать в размещённой аутентификации и учёте использования, но ни сервер Happier, ни ретранслятор не передают аудио живого разговора. ElevenLabs может обрабатывать и хранить полученные данные в соответствии с настройками вашей учётной записи ElevenLabs и его условиями. Элементы управления обменом голосовым контекстом отделены от обработки этим провайдером.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "Насколько он похож на исходный голос.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "Как быстро говорит голос.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "Насколько ровно звучит голос."
          }
        },
        {
          "locale": "pl",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "Po zmianie głosu zaktualizuj agenta, aby ElevenLabs go używał.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "ID agenta zapisane. Zaktualizuj po zmianie głosu.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Uzupełniane, gdy Happier tworzy Twojego agenta.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Utwórz agenta lub wpisz powyżej jego ID.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Agent głosowy Happier",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Konto",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Rozmowa",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Głos",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "Zarządzaj kluczami API",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Który model głosu ElevenLabs mówi. Domyślny pasuje do większości głosów.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Otwórz swoje konto ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "Dźwięk i treść rozmowy są wysyłane z tego urządzenia do ElevenLabs przez połączenie klienta ElevenLabs. W zależności od wybranej konfiguracji Happier może również wysyłać do ElevenLabs ograniczone instrukcje agenta, definicje i wyniki narzędzi klienckich oraz żądania uwierzytelniania lub provisioningu wymagane przez tę funkcję. Serwer Happier może uczestniczyć w hostowanym uwierzytelnianiu i rozliczaniu użycia, ale ani serwer Happier, ani przekaźnik nie przesyłają dźwięku rozmowy na żywo. ElevenLabs może przetwarzać i przechowywać otrzymane dane zgodnie z ustawieniami Twojego konta ElevenLabs i jego warunkami. Kontrolki udostępniania kontekstu głosowego są odrębne od przetwarzania przez tego dostawcę.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "Jak bardzo przypomina oryginalny głos.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "Jak szybko mówi głos.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "Jak równo brzmi głos."
          }
        },
        {
          "locale": "es",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "Después de cambiar la voz, actualiza tu agente para que ElevenLabs la use.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "ID del agente guardado. Actualiza tras cambiar la voz.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Se rellena cuando Happier crea tu agente.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Crea un agente o introduce su ID arriba.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Agente de voz de Happier",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Cuenta",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Conversación",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Voz",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "Gestionar claves API",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Qué modelo de voz de ElevenLabs habla. El predeterminado sirve para la mayoría de las voces.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Abre tu cuenta de ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "El audio y el contenido de la conversación se envían desde este dispositivo a ElevenLabs mediante la conexión del cliente de ElevenLabs. Según la configuración seleccionada, Happier también puede enviar a ElevenLabs instrucciones acotadas del agente, definiciones y resultados de herramientas del cliente, y solicitudes de autenticación o aprovisionamiento necesarias para la función. El servidor de Happier puede participar en la autenticación alojada y la contabilidad de uso, pero ni el servidor de Happier ni el relé transportan el audio de la conversación en directo. ElevenLabs puede procesar y conservar los datos recibidos según la configuración y los términos de tu cuenta de ElevenLabs. Los controles para compartir el contexto de voz son independientes del procesamiento por este proveedor.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "Cuánto se parece a la voz original.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "La rapidez con la que habla.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "La estabilidad del sonido de la voz."
          }
        },
        {
          "locale": "fr",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "Après un changement de voix, mettez à jour votre agent pour qu’ElevenLabs l’utilise.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "Identifiant enregistré. Mettez à jour après un changement de voix.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Renseigné lorsque Happier crée votre agent.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Créez un agent ou saisissez son identifiant ci-dessus.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Agent vocal Happier",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Compte",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Conversation",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Voix",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "Gérer les clés API",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Le modèle vocal ElevenLabs qui parle. Le modèle par défaut convient à la plupart des voix.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Ouvrir votre compte ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "L’audio et le contenu de la conversation sont envoyés depuis cet appareil à ElevenLabs via la connexion cliente d’ElevenLabs. Selon la configuration choisie, Happier peut également envoyer à ElevenLabs des instructions d’agent limitées, des définitions et résultats d’outils côté client, ainsi que les demandes d’authentification ou de provisionnement nécessaires à cette fonctionnalité. Le serveur Happier peut participer à l’authentification hébergée et à la comptabilisation de l’utilisation, mais ni le serveur Happier ni le relais ne transportent l’audio de la conversation en direct. ElevenLabs peut traiter et conserver les données reçues selon les paramètres et les conditions de votre compte ElevenLabs. Les contrôles de partage du contexte vocal sont distincts du traitement par ce fournisseur.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "Sa ressemblance avec la voix d’origine.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "La vitesse à laquelle la voix parle.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "La régularité du son de la voix."
          }
        },
        {
          "locale": "it",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "Dopo aver cambiato voce, aggiorna il tuo agente affinché ElevenLabs la usi.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "ID agente salvato. Aggiorna dopo aver cambiato voce.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Compilato quando Happier crea il tuo agente.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Crea un agente o inserisci il suo ID sopra.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Agente vocale Happier",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Account",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Conversazione",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Voce",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "Gestisci chiavi API",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Quale modello vocale ElevenLabs parla. Quello predefinito va bene per la maggior parte delle voci.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Apri il tuo account ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a ElevenLabs tramite la connessione client di ElevenLabs. A seconda della configurazione selezionata, Happier può anche inviare a ElevenLabs istruzioni limitate per l’agente, definizioni e risultati degli strumenti client e richieste di autenticazione o provisioning necessarie per la funzione. Il server di Happier può partecipare all’autenticazione ospitata e alla contabilizzazione dell’utilizzo, ma né il server di Happier né il relay trasportano l’audio della conversazione in diretta. ElevenLabs può elaborare e conservare i dati ricevuti secondo le impostazioni e i termini del tuo account ElevenLabs. I controlli di condivisione del contesto vocale sono separati dall’elaborazione di questo provider.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "Quanto somiglia alla voce originale.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "Quanto velocemente parla la voce.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "Quanto è costante il suono della voce."
          }
        },
        {
          "locale": "pt",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "Depois de mudar a voz, atualize seu agente para que a ElevenLabs a use.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "ID do agente salvo. Atualize após mudar a voz.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Preenchido quando o Happier cria seu agente.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Crie um agente ou informe seu ID acima.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Agente de voz do Happier",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Conta",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Conversa",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Voz",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "Gerenciar chaves de API",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Qual modelo de voz da ElevenLabs fala. O padrão atende à maioria das vozes.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Abrir sua conta ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "O áudio e o conteúdo da conversa são enviados deste dispositivo para a ElevenLabs através da ligação do cliente ElevenLabs. Consoante a configuração selecionada, a Happier também pode enviar à ElevenLabs instruções limitadas do agente, definições e resultados de ferramentas do cliente e pedidos de autenticação ou aprovisionamento necessários para a funcionalidade. O servidor da Happier pode participar na autenticação alojada e na contabilização de utilização, mas nem o servidor da Happier nem o relay transportam o áudio da conversa em direto. A ElevenLabs pode processar e reter os dados recebidos de acordo com as definições e os termos da sua conta ElevenLabs. Os controlos de partilha de contexto de voz são separados do processamento por este fornecedor.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "O quanto ela se parece com a voz original.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "A velocidade com que a voz fala.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "A estabilidade do som da voz."
          }
        },
        {
          "locale": "ca",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "Després de canviar la veu, actualitza l’agent perquè ElevenLabs la faci servir.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "ID de l’agent desat. Actualitza’l després de canviar la veu.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "S’emplena quan Happier crea el teu agent.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Crea un agent o introdueix-ne l’ID a sobre.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Agent de veu de Happier",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Compte",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Conversa",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Veu",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "Gestiona les claus API",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Quin model de veu d’ElevenLabs parla. El predeterminat s’adiu amb la majoria de veus.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Obre el teu compte d’ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a ElevenLabs mitjançant la connexió del client d’ElevenLabs. Segons la configuració seleccionada, Happier també pot enviar a ElevenLabs instruccions limitades de l’agent, definicions i resultats d’eines del client, i sol·licituds d’autenticació o aprovisionament necessàries per a la funció. El servidor de Happier pot participar en l’autenticació allotjada i la comptabilització d’ús, però ni el servidor de Happier ni el relé transporten l’àudio de la conversa en directe. ElevenLabs pot processar i conservar les dades rebudes segons la configuració i les condicions del vostre compte d’ElevenLabs. Els controls per compartir el context de veu són independents del processament per aquest proveïdor.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "Com s’assembla a la veu original.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "Com de ràpid parla la veu.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "Com d’estable sona la veu."
          }
        },
        {
          "locale": "de",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "Aktualisiere deinen Agenten nach einer Stimmänderung, damit ElevenLabs sie verwendet.",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "Agenten-ID gespeichert. Nach einer Stimmänderung aktualisieren.",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Wird ausgefüllt, wenn Happier deinen Agenten erstellt.",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "Erstelle einen Agenten oder gib oben seine ID ein.",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Happier-Sprachagent",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "Konto",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "Gespräch",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "Stimme",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "API-Schlüssel verwalten",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "Welches ElevenLabs-Sprachmodell spricht. Standard passt für die meisten Stimmen.",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "Dein ElevenLabs-Konto öffnen",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "Audio und Gesprächsinhalte werden von diesem Gerät über die ElevenLabs-Clientverbindung an ElevenLabs gesendet. Abhängig von der ausgewählten Einrichtung kann Happier außerdem begrenzte Agentenanweisungen, Client-Tool-Definitionen und -Ergebnisse sowie für die Funktion erforderliche Authentifizierungs- oder Bereitstellungsanfragen an ElevenLabs senden. Der Happier-Server kann an gehosteter Authentifizierung und Nutzungsabrechnung beteiligt sein, aber weder der Happier-Server noch das Relay übertragen Live-Gesprächsaudio. ElevenLabs kann empfangene Daten gemäß den Einstellungen und Bedingungen Ihres ElevenLabs-Kontos verarbeiten und speichern. Steuerelemente zur Freigabe des Sprachkontexts sind von der Verarbeitung durch diesen Anbieter getrennt.",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "Wie nah sie der Originalstimme kommt.",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "Wie schnell die Stimme spricht.",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "Wie gleichmäßig die Stimme klingt."
          }
        },
        {
          "locale": "zh-Hans",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "更改声音后，更新代理，让 ElevenLabs 使用它。",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "代理 ID 已保存。更改声音后请更新。",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Happier 创建代理时会自动填写。",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "创建代理，或在上方输入它的 ID。",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Happier 语音代理",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "账户",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "对话",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "声音",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "管理 API 密钥",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "选择说话的 ElevenLabs 语音模型。默认模型适合大多数声音。",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "打开你的 ElevenLabs 账户",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "音频和对话内容会通过 ElevenLabs 客户端连接从此设备发送到 ElevenLabs。根据所选设置，Happier 还可能向 ElevenLabs 发送受限的代理指令、客户端工具定义和结果，以及此功能所需的身份验证或预配请求。Happier 服务器可能参与托管身份验证和使用情况核算，但 Happier 服务器和中继均不传输实时对话音频。ElevenLabs 可能会根据您的 ElevenLabs 帐户设置和其条款处理并保留收到的数据。语音上下文共享控件独立于此提供商的处理。",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "与原始声音的相似程度。",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "声音的说话速度。",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "声音的稳定程度。"
          }
        },
        {
          "locale": "zh-Hant",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "變更聲音後，更新代理，讓 ElevenLabs 使用它。",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "代理 ID 已儲存。變更聲音後請更新。",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Happier 建立代理時會自動填入。",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "建立代理，或在上方輸入它的 ID。",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Happier 語音代理",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "帳戶",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "對話",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "聲音",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "管理 API 金鑰",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "選擇說話的 ElevenLabs 語音模型。預設模型適合大多數聲音。",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "開啟你的 ElevenLabs 帳戶",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "音訊和對話內容會透過 ElevenLabs 用戶端連線從此裝置傳送至 ElevenLabs。根據所選設定，Happier 也可能向 ElevenLabs 傳送受限的代理程式指示、用戶端工具定義和結果，以及此功能所需的驗證或佈建請求。Happier 伺服器可能參與代管驗證和使用量核算，但 Happier 伺服器和轉送均不傳輸即時對話音訊。ElevenLabs 可能會根據您的 ElevenLabs 帳戶設定和其條款處理並保留收到的資料。語音脈絡共用控制項獨立於此提供者的處理。",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "與原始聲音的相似程度。",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "聲音的說話速度。",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "聲音的穩定程度。"
          }
        },
        {
          "locale": "ja",
          "messages": {
            "settingsVoice.realtimeProviders.elevenLabs.accountFooter": "声を変えたらエージェントを更新して、ElevenLabsに反映してください。",
            "settingsVoice.realtimeProviders.elevenLabs.agentConfigured": "エージェントIDを保存済み。声を変えたら更新してください。",
            "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription": "Happierがエージェントを作成すると入力されます。",
            "settingsVoice.realtimeProviders.elevenLabs.agentMissing": "エージェントを作成するか、上にIDを入力してください。",
            "settingsVoice.realtimeProviders.elevenLabs.agentTitle": "Happier音声エージェント",
            "settingsVoice.realtimeProviders.elevenLabs.groups.account": "アカウント",
            "settingsVoice.realtimeProviders.elevenLabs.groups.conversation": "会話",
            "settingsVoice.realtimeProviders.elevenLabs.groups.voice": "音声",
            "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys": "APIキーを管理",
            "settingsVoice.realtimeProviders.elevenLabs.modelDescription": "使用するElevenLabs音声モデル。既定のモデルはほとんどの声に適しています。",
            "settingsVoice.realtimeProviders.elevenLabs.openAccount": "自分のElevenLabsアカウントを開く",
            "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure": "音声と会話内容は、このデバイスから ElevenLabs クライアント接続を通じて ElevenLabs に送信されます。選択した設定に応じて、Happier は限定されたエージェント指示、クライアントツールの定義と結果、およびこの機能に必要な認証またはプロビジョニング要求も ElevenLabs に送信することがあります。Happier のサーバーはホスト型認証と使用量計測に関与する場合がありますが、Happier のサーバーもリレーもライブ会話音声を転送しません。ElevenLabs は、受信したデータをお客様の ElevenLabs アカウント設定およびその規約に従って処理・保持する場合があります。音声コンテキスト共有の制御は、このプロバイダーによる処理とは別です。",
            "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle": "ElevenLabs",
            "settingsVoice.realtimeProviders.elevenLabs.similarityDescription": "元の声にどれだけ似せるか。",
            "settingsVoice.realtimeProviders.elevenLabs.speedDescription": "声の話す速さ。",
            "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription": "声の安定性。"
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
          "exportName": "activate"
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
                  "operation": "agent",
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
        "mark": {
          "kind": "icon",
          "name": "waveform"
        },
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
          "presentation": {
            "credential": {
              "catalog": "voices",
              "credentialPurpose": "voice.client-auth.elevenlabs",
              "kind": "api_key",
              "promptBodyKey": "settingsVoice.byo.apiKeyDescription",
              "promptTitleKey": "settingsVoice.byo.apiKeyTitle",
              "titleKey": "settingsVoice.byo.apiKeyTitle"
            },
            "fields": [
              {
                "immediateRequiresLiteral": true,
                "kind": "welcome",
                "path": "welcome",
                "subtitleKey": "settingsVoice.byo.realtime.call.welcome.subtitle",
                "titleKey": "settingsVoice.byo.realtime.call.welcome.title"
              },
              {
                "kind": "text",
                "path": "agentId",
                "promptBodyKey": "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription",
                "promptTitleKey": "settingsVoice.byo.agentIdTitle",
                "subtitleKey": "settingsVoice.realtimeProviders.elevenLabs.agentIdDescription",
                "titleKey": "settingsVoice.byo.agentIdTitle"
              },
              {
                "catalog": "voices",
                "kind": "remote_voice",
                "path": "tts.voiceId",
                "searchPlaceholderKey": "settingsVoice.byo.voiceSearchPlaceholder",
                "subtitleKey": "settingsVoice.byo.realtime.voicePicker.subtitle",
                "titleKey": "settingsVoice.byo.realtime.voicePicker.title"
              },
              {
                "kind": "select",
                "options": [
                  {
                    "id": "",
                    "subtitleKey": "settingsVoice.byo.realtime.modelPicker.options.autoSubtitle",
                    "titleKey": "settingsVoice.byo.realtime.modelPicker.options.autoTitle"
                  },
                  {
                    "id": "eleven_multilingual_v2",
                    "subtitleKey": "settingsVoice.byo.realtime.modelPicker.options.multilingualV2Subtitle",
                    "title": "eleven_multilingual_v2"
                  },
                  {
                    "id": "eleven_turbo_v2",
                    "subtitleKey": "settingsVoice.byo.realtime.modelPicker.options.turboV2Subtitle",
                    "title": "eleven_turbo_v2"
                  },
                  {
                    "id": "eleven_turbo_v2_5",
                    "subtitleKey": "settingsVoice.byo.realtime.modelPicker.options.turboV25Subtitle",
                    "title": "eleven_turbo_v2_5"
                  },
                  {
                    "id": "custom",
                    "subtitleKey": "settingsVoice.byo.realtime.modelPicker.options.customSubtitle",
                    "titleKey": "settingsVoice.byo.realtime.modelPicker.options.customTitle"
                  }
                ],
                "path": "tts.modelId",
                "promptBodyKey": "settingsVoice.realtimeProviders.elevenLabs.modelDescription",
                "promptTitleKey": "settingsVoice.byo.realtime.modelPicker.prompt.title",
                "subtitleKey": "settingsVoice.realtimeProviders.elevenLabs.modelDescription",
                "titleKey": "settingsVoice.byo.realtime.modelPicker.title"
              },
              {
                "defaultValue": 0.5,
                "kind": "range",
                "max": 1,
                "min": 0,
                "nullable": true,
                "path": "tts.voiceSettings.stability",
                "promptBodyKey": "settingsVoice.byo.realtime.voiceSettings.stability.promptBody",
                "promptTitleKey": "settingsVoice.byo.realtime.voiceSettings.stability.promptTitle",
                "step": 0.01,
                "subtitleKey": "settingsVoice.realtimeProviders.elevenLabs.stabilityDescription",
                "titleKey": "settingsVoice.byo.realtime.voiceSettings.stability.title"
              },
              {
                "defaultValue": 0.75,
                "kind": "range",
                "max": 1,
                "min": 0,
                "nullable": true,
                "path": "tts.voiceSettings.similarityBoost",
                "promptBodyKey": "settingsVoice.byo.realtime.voiceSettings.similarityBoost.promptBody",
                "promptTitleKey": "settingsVoice.byo.realtime.voiceSettings.similarityBoost.promptTitle",
                "step": 0.01,
                "subtitleKey": "settingsVoice.realtimeProviders.elevenLabs.similarityDescription",
                "titleKey": "settingsVoice.byo.realtime.voiceSettings.similarityBoost.title"
              },
              {
                "defaultValue": 1,
                "fractionDigits": 1,
                "kind": "range",
                "max": 1.2,
                "min": 0.7,
                "nullable": true,
                "path": "tts.voiceSettings.speed",
                "promptBodyKey": "settingsVoice.byo.realtime.voiceSettings.speed.promptBody",
                "promptTitleKey": "settingsVoice.byo.realtime.voiceSettings.speed.promptTitle",
                "step": 0.1,
                "subtitleKey": "settingsVoice.realtimeProviders.elevenLabs.speedDescription",
                "titleKey": "settingsVoice.byo.realtime.voiceSettings.speed.title",
                "valueSuffix": "×"
              }
            ],
            "footerKey": "settingsVoice.realtimeProviders.elevenLabs.accountFooter",
            "groups": [
              {
                "fieldPaths": [
                  "agentId"
                ],
                "id": "account",
                "includeCredentials": true,
                "titleKey": "settingsVoice.realtimeProviders.elevenLabs.groups.account"
              },
              {
                "fieldPaths": [
                  "tts.voiceId",
                  "tts.modelId",
                  "tts.voiceSettings.stability",
                  "tts.voiceSettings.similarityBoost",
                  "tts.voiceSettings.speed"
                ],
                "id": "voice",
                "titleKey": "settingsVoice.realtimeProviders.elevenLabs.groups.voice"
              },
              {
                "fieldPaths": [
                  "welcome"
                ],
                "id": "conversation",
                "titleKey": "settingsVoice.realtimeProviders.elevenLabs.groups.conversation"
              }
            ],
            "kind": "voice.provider-settings.v1",
            "language": {
              "kind": "single_language",
              "supportedLanguageCodes": [
                "ar",
                "bg",
                "cs",
                "da",
                "de",
                "el",
                "en",
                "es",
                "fi",
                "fr",
                "hi",
                "hr",
                "hu",
                "id",
                "it",
                "ja",
                "ko",
                "ms",
                "nl",
                "no",
                "pl",
                "pt",
                "pt-br",
                "ro",
                "ru",
                "sk",
                "sv",
                "ta",
                "tr",
                "uk",
                "vi",
                "zh"
              ]
            },
            "links": {
              "account": "https://elevenlabs.io",
              "apiKeys": "https://elevenlabs.io/app/settings/api-keys"
            },
            "modes": [
              "happier",
              "byo"
            ],
            "titleKey": "settingsVoice.byo.title"
          },
          "privacyDisclosure": {
            "fallback": "Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.",
            "key": "settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure"
          },
          "privacyFacts": {
            "audioDestination": "ElevenLabs",
            "processor": "ElevenLabs",
            "retention": {
              "fallback": "Follows your service account settings and terms.",
              "key": "settingsVoice.pages.privacy.servicePolicy"
            }
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
    "webhooks": [],
    "workflows": []
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
    "captureSources": [],
    "commands": [],
    "composerAttachments": [],
    "composerControls": [],
    "composerReferences": [],
    "composerRegions": [],
    "connectedAccountDescriptors": [],
    "daemonDatabases": [],
    "dragSources": [],
    "dropTargets": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [],
    "inputTypes": [],
    "machineProvisioners": [],
    "managedDependencies": [],
    "mcp": {
      "discoverySources": [],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "projectNativeAdapters": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "roles": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "searchProviders": [],
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
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "Audio sent for transcription is processed by Google Gemini. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "Text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms."
          }
        },
        {
          "locale": "ru",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "Аудио, отправленное на транскрипцию, обрабатывается Google Gemini. Happier отправляет эти запросы через выбранную исполнительную машину, используя учетные данные Google API этой машины. Google может сохранять полученные данные в соответствии с настройками выбранной учетной записи Google и условиями Google.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "Текст, отправленный на речь, обрабатывается Google Cloud Text-to-Speech. Happier отправляет эти запросы через выбранную исполнительную машину, используя учетные данные Google API этой машины. Google может сохранять полученные данные в соответствии с настройками выбранной учетной записи Google и условиями Google."
          }
        },
        {
          "locale": "pl",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "Dźwięk przesyłany do transkrypcji jest przetwarzany przez Google Gemini. Happier wysyła te żądania za pośrednictwem wybranej maszyny wykonawczej, korzystając z danych uwierzytelniających Google API tej maszyny. Google może zachować otrzymane dane zgodnie z wybranymi ustawieniami konta Google i warunkami Google.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "Tekst przesyłany do mowy jest przetwarzany przez Google Cloud Text-to-Speech. Happier wysyła te żądania za pośrednictwem wybranej maszyny wykonawczej, korzystając z danych uwierzytelniających Google API tej maszyny. Google może zachować otrzymane dane zgodnie z wybranymi ustawieniami konta Google i warunkami Google."
          }
        },
        {
          "locale": "es",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "El audio enviado para transcripción lo procesa Google Gemini. Happier envía estas solicitudes a través de la máquina de ejecución seleccionada utilizando la credencial API de Google de esa máquina. Google puede conservar los datos recibidos de acuerdo con la configuración de la cuenta de Google seleccionada y los términos de Google.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "El texto enviado para voz lo procesa Google Cloud Text-to-Speech. Happier envía estas solicitudes a través de la máquina de ejecución seleccionada utilizando la credencial API de Google de esa máquina. Google puede conservar los datos recibidos de acuerdo con la configuración de la cuenta de Google seleccionada y los términos de Google."
          }
        },
        {
          "locale": "fr",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "L'audio envoyé pour transcription est traité par Google Gemini. Happier envoie ces requêtes via la machine d'exécution sélectionnée à l'aide des informations d'identification de l'API Google de cette machine. Google peut conserver les données reçues conformément aux paramètres du compte Google sélectionné et aux conditions de Google.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "Le texte envoyé pour la parole est traité par Google Cloud Text-to-Speech. Happier envoie ces requêtes via la machine d'exécution sélectionnée à l'aide des informations d'identification de l'API Google de cette machine. Google peut conserver les données reçues conformément aux paramètres du compte Google sélectionné et aux conditions de Google."
          }
        },
        {
          "locale": "it",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "L'audio inviato per la trascrizione viene elaborato da Google Gemini. Happier invia queste richieste attraverso la macchina di esecuzione selezionata utilizzando le credenziali API di Google di quella macchina. Google può conservare i dati ricevuti in base alle impostazioni dell'account Google selezionato e ai termini di Google.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "Il testo inviato per la sintesi vocale viene elaborato da Google Cloud Text-to-Speech. Happier invia queste richieste attraverso la macchina di esecuzione selezionata utilizzando le credenziali API di Google di quella macchina. Google può conservare i dati ricevuti in base alle impostazioni dell'account Google selezionato e ai termini di Google."
          }
        },
        {
          "locale": "pt",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "O áudio enviado para transcrição é processado pelo Google Gemini. Happier envia essas solicitações por meio da máquina de execução selecionada usando a credencial da API do Google dessa máquina. O Google pode reter os dados recebidos de acordo com as configurações da conta do Google selecionada e os termos do Google.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "O texto enviado para fala é processado pelo Google Cloud Text-to-Speech. Happier envia essas solicitações por meio da máquina de execução selecionada usando a credencial da API do Google dessa máquina. O Google pode reter os dados recebidos de acordo com as configurações da conta do Google selecionada e os termos do Google."
          }
        },
        {
          "locale": "de",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "Audio, das zur Transkription gesendet wird, verarbeitet Google Gemini. Happier sendet diese Anfragen über den gewählten Ausführungsrechner mit dem Google-API-Zugangsschlüssel dieses Rechners. Google kann empfangene Daten gemäß den Einstellungen des gewählten Google-Kontos und den Bedingungen von Google aufbewahren.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "Text, der zur Sprachausgabe gesendet wird, verarbeitet Google Cloud Text-to-Speech. Happier sendet diese Anfragen über den gewählten Ausführungsrechner mit dem Google-API-Zugangsschlüssel dieses Rechners. Google kann empfangene Daten gemäß den Einstellungen des gewählten Google-Kontos und den Bedingungen von Google aufbewahren."
          }
        },
        {
          "locale": "ca",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "Google Gemini processa l'àudio enviat per a la transcripció. Happier envia aquestes sol·licituds a través de la màquina d'execució seleccionada mitjançant la credencial de l'API de Google d'aquesta màquina. Google pot conservar les dades rebudes d'acord amb la configuració del compte de Google seleccionat i els termes de Google.",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "Google Cloud Text-to-Speech processa el text enviat per a la veu. Happier envia aquestes sol·licituds a través de la màquina d'execució seleccionada mitjançant la credencial de l'API de Google d'aquesta màquina. Google pot conservar les dades rebudes d'acord amb la configuració del compte de Google seleccionat i els termes de Google."
          }
        },
        {
          "locale": "zh-Hans",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "发送用于转录的音频由 Google Gemini 处理。Happier 使用该机器的 Google API 凭证通过选定的执行机器发送这些请求。Google 可能会根据所选 Google 帐户的设置和 Google 条款保留收到的数据。",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "发送用于语音的文本由 Google Cloud 文本转语音处理。Happier 使用该机器的 Google API 凭证通过选定的执行机器发送这些请求。Google 可能会根据所选 Google 帐户的设置和 Google 条款保留收到的数据。"
          }
        },
        {
          "locale": "zh-Hant",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "發送用於轉錄的音訊由 Google Gemini 處理。Happier 使用該機器的 Google API 認證透過選定的執行機器發送這些請求。Google 可能會根據所選 Google 帳戶的設定和 Google 條款保留收到的資料。",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "發送用於語音的文字由 Google Cloud 文字轉語音處理。Happier 使用該機器的 Google API 認證透過選定的執行機器發送這些請求。Google 可能會根據所選 Google 帳戶的設定和 Google 條款保留收到的資料。"
          }
        },
        {
          "locale": "ja",
          "messages": {
            "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure": "文字起こしのために送信された音声は Google Gemini によって処理されます。Happier は、選択した実行マシンの Google API 認証情報を使用して、これらのリクエストをそのマシン経由で送信します。Google は、選択した Google アカウントの設定および Google の規約に従って、受信したデータを保持する場合があります。",
            "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure": "音声として送信されたテキストは Google Cloud Text-to-Speech によって処理されます。Happier は、選択した実行マシンの Google API 認証情報を使用して、これらのリクエストをそのマシン経由で送信します。Google は、選択した Google アカウントの設定および Google の規約に従って、受信したデータを保持する場合があります。"
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
            "fallback": "Audio sent for transcription is processed by Google Gemini. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.",
            "key": "settingsVoice.realtimeProviders.google.sttPrivacyDisclosure"
          },
          "privacyFacts": {
            "audioDestination": "Google",
            "processor": "Google Gemini",
            "retention": {
              "fallback": "Follows your service account settings and terms.",
              "key": "settingsVoice.pages.privacy.servicePolicy"
            }
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
            "maxInputUtf8Bytes": 5000,
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
            "fallback": "Text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.",
            "key": "settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure"
          },
          "privacyFacts": {
            "audioDestination": {
              "fallback": "No microphone audio; reply text only.",
              "key": "settingsVoice.pages.privacy.noMicrophoneAudio"
            },
            "processor": "Google Cloud Text-to-Speech",
            "retention": {
              "fallback": "Follows your service account settings and terms.",
              "key": "settingsVoice.pages.privacy.servicePolicy"
            }
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
    "webhooks": [],
    "workflows": []
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
    "captureSources": [],
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
              "directExport": {
                "contractVersion": "happier.team-credential-manual-connected-account-direct.v1"
              },
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
    "dragSources": [],
    "dropTargets": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [],
    "inputTypes": [],
    "machineProvisioners": [],
    "managedDependencies": [],
    "mcp": {
      "discoverySources": [],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "projectNativeAdapters": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "roles": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "searchProviders": [],
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
            "clearInput": true
          }
        },
        "client": {
          "artifactId": "voice-runtime-web",
          "exportName": "activate"
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
                  },
                  "requiredHeaderNames": [
                    "authorization"
                  ]
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
                  },
                  "requiredHeaderNames": [
                    "authorization"
                  ]
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
        "mark": {
          "kind": "connected_service",
          "serviceId": "openai"
        },
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
          "presentation": {
            "credential": {
              "catalog": "voices",
              "credentialPurpose": "voice.client-auth",
              "kind": "api_key",
              "promptBodyKey": "settingsVoice.realtimeProviders.credential.promptBody",
              "promptTitleKey": "settingsVoice.realtimeProviders.credential.promptTitle",
              "titleKey": "settingsVoice.realtimeProviders.credential.title"
            },
            "fields": [
              {
                "customIdAllowed": true,
                "kind": "model",
                "movingAliasRequiresOptIn": true,
                "options": [
                  {
                    "id": "gpt-realtime-2.1",
                    "kind": "pinned"
                  },
                  {
                    "id": "gpt-realtime",
                    "kind": "moving_alias"
                  }
                ],
                "path": "model",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.model.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.model.title"
              },
              {
                "customIdAllowed": true,
                "kind": "voice_catalog",
                "path": "voice",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.voice.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.voice.title",
                "valueShape": "string"
              },
              {
                "kind": "instructions",
                "maxLength": 10000,
                "path": "instructions",
                "promptBodyKey": "settingsVoice.realtimeProviders.fields.instructions.promptBody",
                "promptTitleKey": "settingsVoice.realtimeProviders.fields.instructions.promptTitle",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.instructions.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.instructions.title"
              },
              {
                "kind": "select",
                "options": [
                  "server_vad",
                  "semantic_vad",
                  "manual"
                ],
                "path": "turnDetection",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.turnDetection.title"
              },
              {
                "kind": "select",
                "options": [
                  {
                    "id": "",
                    "titleKey": "settingsVoice.realtimeProviders.options.automatic"
                  },
                  {
                    "id": "gpt-4o-mini-transcribe",
                    "title": "gpt-4o-mini-transcribe"
                  },
                  {
                    "id": "custom",
                    "titleKey": "settingsVoice.realtimeProviders.options.custom"
                  }
                ],
                "path": "inputTranscriptionModel",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.transcriptionModel.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.transcriptionModel.title"
              }
            ],
            "footerKey": "settingsVoice.realtimeProviders.authentication.footer",
            "kind": "voice.provider-settings.v1",
            "language": {
              "kind": "automatic_recognition"
            },
            "links": {
              "account": "https://platform.openai.com",
              "apiKeys": "https://platform.openai.com/api-keys",
              "privacy": "https://openai.com/policies/privacy-policy/"
            },
            "modes": [
              "byo"
            ],
            "titleKey": "settingsVoice.realtimeProviders.setup.title"
          },
          "privacyDisclosure": {
            "fallback": "Audio and conversation content are sent from this device to OpenAI using WebRTC. When enabled or used, OpenAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the selected Saved Voice API key, OpenAI Connected Service, or experimental Codex OAuth account to mint short-lived client authentication; connected accounts are accessed through the selected machine. OpenAI processes the live conversation under the selected account and may retain received data according to that account’s settings and OpenAI’s terms. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.",
            "key": "settingsVoice.realtimeProviders.openai.privacyDisclosure"
          },
          "privacyFacts": {
            "audioDestination": "OpenAI",
            "processor": "OpenAI Realtime",
            "retention": {
              "fallback": "Follows your service account settings and terms.",
              "key": "settingsVoice.pages.privacy.servicePolicy"
            }
          },
          "schemaVersion": 1
        },
        "title": "OpenAI Realtime Voice"
      }
    ],
    "webhooks": [],
    "workflows": []
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
    "captureSources": [],
    "commands": [],
    "composerAttachments": [],
    "composerControls": [],
    "composerReferences": [],
    "composerRegions": [],
    "connectedAccountDescriptors": [],
    "daemonDatabases": [],
    "dragSources": [],
    "dropTargets": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [],
    "inputTypes": [],
    "machineProvisioners": [],
    "managedDependencies": [],
    "mcp": {
      "discoverySources": [],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "projectNativeAdapters": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "roles": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "searchProviders": [],
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
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "Audio for transcription is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "Reply text for speech synthesis is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms."
          }
        },
        {
          "locale": "ru",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "Аудио для распознавания речи отправляется с выбранной машины выполнения на настроенную вами OpenAI-совместимую конечную точку. Оператор конечной точки может хранить полученные данные в соответствии со своими условиями.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "Текст ответа для синтеза речи отправляется с выбранной машины выполнения на настроенную вами OpenAI-совместимую конечную точку. Оператор конечной точки может хранить полученные данные в соответствии со своими условиями."
          }
        },
        {
          "locale": "pl",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "Dźwięk do transkrypcji jest wysyłany z wybranej maszyny wykonawczej do skonfigurowanego punktu końcowego zgodnego z OpenAI. Operator punktu końcowego może przechowywać otrzymane dane zgodnie z własnymi warunkami.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "Tekst odpowiedzi do syntezy mowy jest wysyłany z wybranej maszyny wykonawczej do skonfigurowanego punktu końcowego zgodnego z OpenAI. Operator punktu końcowego może przechowywać otrzymane dane zgodnie z własnymi warunkami."
          }
        },
        {
          "locale": "es",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "El audio para la transcripción se envía desde la máquina de ejecución seleccionada al punto de conexión compatible con OpenAI que configures. Su operador puede conservar los datos recibidos según sus propias condiciones.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "El texto de la respuesta para la síntesis de voz se envía desde la máquina de ejecución seleccionada al punto de conexión compatible con OpenAI que configures. Su operador puede conservar los datos recibidos según sus propias condiciones."
          }
        },
        {
          "locale": "fr",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "L’audio destiné à la transcription est envoyé depuis la machine d’exécution sélectionnée vers le point de terminaison compatible OpenAI que vous configurez. Son opérateur peut conserver les données reçues selon ses propres conditions.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "Le texte de la réponse destiné à la synthèse vocale est envoyé depuis la machine d’exécution sélectionnée vers le point de terminaison compatible OpenAI que vous configurez. Son opérateur peut conserver les données reçues selon ses propres conditions."
          }
        },
        {
          "locale": "it",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "L’audio per la trascrizione viene inviato dalla macchina di esecuzione selezionata all’endpoint compatibile con OpenAI configurato. Il gestore dell’endpoint può conservare i dati ricevuti secondo le proprie condizioni.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "Il testo della risposta per la sintesi vocale viene inviato dalla macchina di esecuzione selezionata all’endpoint compatibile con OpenAI configurato. Il gestore dell’endpoint può conservare i dati ricevuti secondo le proprie condizioni."
          }
        },
        {
          "locale": "pt",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "O áudio para transcrição é enviado da máquina de execução selecionada para o endpoint compatível com OpenAI que configurar. O operador do endpoint pode conservar os dados recebidos de acordo com os respetivos termos.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "O texto da resposta para síntese de voz é enviado da máquina de execução selecionada para o endpoint compatível com OpenAI que configurar. O operador do endpoint pode conservar os dados recebidos de acordo com os respetivos termos."
          }
        },
        {
          "locale": "de",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "Audio für die Transkription wird vom gewählten Ausführungsrechner an den von dir konfigurierten OpenAI-kompatiblen Endpunkt gesendet. Der Betreiber des Endpunkts kann empfangene Daten gemäß seinen eigenen Bedingungen aufbewahren.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "Antworttext für die Sprachsynthese wird vom gewählten Ausführungsrechner an den von dir konfigurierten OpenAI-kompatiblen Endpunkt gesendet. Der Betreiber des Endpunkts kann empfangene Daten gemäß seinen eigenen Bedingungen aufbewahren."
          }
        },
        {
          "locale": "ca",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "L’àudio per a la transcripció s’envia des de la màquina d’execució seleccionada al punt final compatible amb OpenAI que configuris. L’operador del punt final pot conservar les dades rebudes segons les seves condicions.",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "El text de la resposta per a la síntesi de veu s’envia des de la màquina d’execució seleccionada al punt final compatible amb OpenAI que configuris. L’operador del punt final pot conservar les dades rebudes segons les seves condicions."
          }
        },
        {
          "locale": "zh-Hans",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "用于转录的音频会从所选执行计算机发送到您配置的 OpenAI 兼容端点。端点运营商可能会根据其自身条款保留收到的数据。",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "用于语音合成的回复文本会从所选执行计算机发送到您配置的 OpenAI 兼容端点。端点运营商可能会根据其自身条款保留收到的数据。"
          }
        },
        {
          "locale": "zh-Hant",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "用於轉錄的音訊會從所選執行電腦傳送至您設定的 OpenAI 相容端點。端點營運商可能會依其自身條款保留收到的資料。",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "用於語音合成的回覆文字會從所選執行電腦傳送至您設定的 OpenAI 相容端點。端點營運商可能會依其自身條款保留收到的資料。"
          }
        },
        {
          "locale": "ja",
          "messages": {
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt": "文字起こし用の音声は、選択した実行マシンから設定済みの OpenAI 互換エンドポイントへ送信されます。エンドポイントの運営者は、独自の規約に従って受信データを保持する場合があります。",
            "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts": "音声合成用の応答テキストは、選択した実行マシンから設定済みの OpenAI 互換エンドポイントへ送信されます。エンドポイントの運営者は、独自の規約に従って受信データを保持する場合があります。"
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
            "fallback": "Audio for transcription is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.",
            "key": "settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt"
          },
          "privacyFacts": {
            "audioDestination": {
              "fallback": "Your configured endpoint",
              "key": "settingsVoice.pages.privacy.yourEndpoint"
            },
            "processor": {
              "fallback": "Your endpoint operator",
              "key": "settingsVoice.pages.privacy.endpointOperator"
            },
            "retention": {
              "fallback": "Follows your endpoint operator’s policy.",
              "key": "settingsVoice.pages.privacy.endpointPolicy"
            }
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
            "maxInputCharactersSettingId": "maxInputCharacters",
            "maxOutputBytes": 16777216
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
              "default": 4096,
              "description": "OpenAI accepts 4,096 characters. For a custom endpoint, use its documented input limit.",
              "id": "maxInputCharacters",
              "presentation": {
                "control": "number",
                "step": 1
              },
              "schema": {
                "maximum": 200000,
                "minimum": 1,
                "type": "integer"
              },
              "title": "Endpoint input limit (characters)"
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
            "fallback": "Reply text for speech synthesis is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.",
            "key": "settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts"
          },
          "privacyFacts": {
            "audioDestination": {
              "fallback": "No microphone audio; reply text only.",
              "key": "settingsVoice.pages.privacy.noMicrophoneAudio"
            },
            "processor": {
              "fallback": "Your endpoint operator",
              "key": "settingsVoice.pages.privacy.endpointOperator"
            },
            "retention": {
              "fallback": "Follows your endpoint operator’s policy.",
              "key": "settingsVoice.pages.privacy.endpointPolicy"
            }
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
    "webhooks": [],
    "workflows": []
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
    "captureSources": [],
    "commands": [],
    "composerAttachments": [],
    "composerControls": [],
    "composerReferences": [],
    "composerRegions": [],
    "connectedAccountDescriptors": [],
    "daemonDatabases": [],
    "dragSources": [],
    "dropTargets": [],
    "events": [],
    "executionRunProfiles": [],
    "hooks": [],
    "inputTypes": [],
    "machineProvisioners": [],
    "managedDependencies": [],
    "mcp": {
      "discoverySources": [],
      "servers": []
    },
    "notificationChannels": [],
    "notifications": [],
    "openableContentViewers": [],
    "pluginContributionPoints": [],
    "projectNativeAdapters": [],
    "promptAssets": [],
    "providers": [],
    "requestInterceptors": [],
    "resources": [],
    "roles": [],
    "scmBackends": [],
    "scmHostingProviders": [],
    "searchProviders": [],
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
          "exportName": "activate"
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
        "mark": {
          "agentId": "grok",
          "kind": "agent"
        },
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
          "presentation": {
            "credential": {
              "catalog": "voices",
              "credentialPurpose": "voice.client-auth",
              "kind": "api_key",
              "promptBodyKey": "settingsVoice.realtimeProviders.xai.credential.promptBody",
              "promptTitleKey": "settingsVoice.realtimeProviders.credential.promptTitle",
              "titleKey": "settingsVoice.realtimeProviders.credential.title"
            },
            "fields": [
              {
                "kind": "model",
                "movingAliasRequiresOptIn": true,
                "options": [
                  {
                    "id": "grok-voice-think-fast-2.0",
                    "kind": "pinned"
                  },
                  {
                    "id": "grok-voice-latest",
                    "kind": "moving_alias"
                  }
                ],
                "path": "model",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.model.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.model.title"
              },
              {
                "customIdAllowed": true,
                "kind": "voice_catalog",
                "path": "voice",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.voice.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.voice.title"
              },
              {
                "kind": "instructions",
                "maxLength": 10000,
                "path": "instructions",
                "promptBodyKey": "settingsVoice.realtimeProviders.fields.instructions.promptBody",
                "promptTitleKey": "settingsVoice.realtimeProviders.fields.instructions.promptTitle",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.instructions.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.instructions.title"
              },
              {
                "kind": "segmented",
                "options": [
                  "high",
                  "none"
                ],
                "path": "reasoningEffort",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.reasoning.subtitle",
                "supportedModelIds": [
                  "grok-voice-latest",
                  "grok-voice-think-fast-2.0",
                  "grok-voice-think-fast-1.0"
                ],
                "titleKey": "settingsVoice.realtimeProviders.fields.reasoning.title"
              },
              {
                "kind": "range",
                "max": 1.5,
                "min": 0.7,
                "path": "outputSpeed",
                "promptBodyKey": "settingsVoice.realtimeProviders.fields.outputSpeed.promptBody",
                "promptTitleKey": "settingsVoice.realtimeProviders.fields.outputSpeed.promptTitle",
                "reset": 1,
                "step": 0.05,
                "subtitleKey": "settingsVoice.realtimeProviders.fields.outputSpeed.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.outputSpeed.title"
              },
              {
                "kind": "language_hint",
                "options": [
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
                "path": "transcription.languageHint",
                "promptBodyKey": "settingsVoice.realtimeProviders.fields.languageHint.promptBody",
                "promptTitleKey": "settingsVoice.realtimeProviders.fields.languageHint.promptTitle",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.languageHint.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.languageHint.title"
              },
              {
                "kind": "keyterms",
                "maxItems": 100,
                "maxLength": 50,
                "path": "transcription.keyterms",
                "promptBodyKey": "settingsVoice.realtimeProviders.fields.keyterms.promptBody",
                "promptTitleKey": "settingsVoice.realtimeProviders.fields.keyterms.promptTitle",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.keyterms.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.keyterms.title"
              },
              {
                "advanced": true,
                "kind": "server_vad",
                "path": "turnDetection",
                "subfields": [
                  {
                    "max": 0.9,
                    "min": 0.1,
                    "nullable": true,
                    "path": "turnDetection.threshold",
                    "promptBodyKey": "settingsVoice.realtimeProviders.fields.turnDetection.threshold.promptBody",
                    "promptTitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.threshold.promptTitle",
                    "subtitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.threshold.subtitle",
                    "suffix": "threshold",
                    "titleKey": "settingsVoice.realtimeProviders.fields.turnDetection.threshold.title"
                  },
                  {
                    "integer": true,
                    "max": 10000,
                    "min": 0,
                    "nullable": true,
                    "path": "turnDetection.silenceDurationMs",
                    "promptBodyKey": "settingsVoice.realtimeProviders.fields.turnDetection.silenceDurationMs.promptBody",
                    "promptTitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.silenceDurationMs.promptTitle",
                    "subtitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.silenceDurationMs.subtitle",
                    "suffix": "silenceDurationMs",
                    "titleKey": "settingsVoice.realtimeProviders.fields.turnDetection.silenceDurationMs.title"
                  },
                  {
                    "integer": true,
                    "max": 10000,
                    "min": 0,
                    "nullable": true,
                    "path": "turnDetection.prefixPaddingMs",
                    "promptBodyKey": "settingsVoice.realtimeProviders.fields.turnDetection.prefixPaddingMs.promptBody",
                    "promptTitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.prefixPaddingMs.promptTitle",
                    "subtitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.prefixPaddingMs.subtitle",
                    "suffix": "prefixPaddingMs",
                    "titleKey": "settingsVoice.realtimeProviders.fields.turnDetection.prefixPaddingMs.title"
                  },
                  {
                    "confirmActionKey": "settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmAction",
                    "confirmBodyKey": "settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmBody",
                    "confirmTitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmTitle",
                    "integer": true,
                    "max": 600000,
                    "min": 1,
                    "nullable": true,
                    "path": "turnDetection.idleTimeoutMs",
                    "promptBodyKey": "settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.promptBody",
                    "promptTitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.promptTitle",
                    "requiresOptIn": true,
                    "subtitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.subtitle",
                    "suffix": "idleTimeoutMs",
                    "titleKey": "settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.title"
                  }
                ],
                "subtitleKey": "settingsVoice.realtimeProviders.fields.turnDetection.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.turnDetection.title"
              },
              {
                "defaultValue": false,
                "forgetAction": "forget_provider_conversation",
                "kind": "privacy_opt_in",
                "path": "resumptionEnabled",
                "subtitleKey": "settingsVoice.realtimeProviders.fields.resumption.subtitle",
                "titleKey": "settingsVoice.realtimeProviders.fields.resumption.title"
              }
            ],
            "footerKey": "settingsVoice.realtimeProviders.xai.setup.footer",
            "kind": "voice.provider-settings.v1",
            "language": {
              "kind": "independent_reply"
            },
            "links": {
              "account": "https://console.x.ai",
              "apiKeys": "https://console.x.ai/team/default/api-keys",
              "privacy": "https://x.ai/legal/privacy-policy"
            },
            "modes": [
              "byo"
            ],
            "titleKey": "settingsVoice.realtimeProviders.setup.title"
          },
          "privacyDisclosure": {
            "fallback": "Audio and conversation content are sent from this device to xAI through the xAI Realtime connection. When enabled or used, xAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the xAI API key saved in your Happier account secrets only for the bounded client-auth and voice-catalog operations. xAI processes the live conversation under that account and may retain received data according to the account settings and xAI’s terms. If resumption is enabled, Happier saves the provider conversation ID; forgetting it removes Happier’s saved ID and does not delete data held by xAI. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.",
            "key": "settingsVoice.realtimeProviders.xai.privacyDisclosure"
          },
          "privacyFacts": {
            "audioDestination": "xAI",
            "processor": "xAI Realtime",
            "retention": {
              "fallback": "Follows your service account settings and terms.",
              "key": "settingsVoice.pages.privacy.servicePolicy"
            }
          },
          "schemaVersion": 1
        },
        "title": "xAI Grok Voice"
      }
    ],
    "webhooks": [],
    "workflows": []
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

export const BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS = createBundledVoiceProviderPresentations(
[
  {
    "providerId": "happier.agent.codex/realtime-codex",
    "settingsSectionId": "voice.provider.realtime_codex"
  },
  {
    "agentAction": {
      "configuredStateKey": "settingsVoice.realtimeProviders.elevenLabs.agentConfigured",
      "createActionId": "create-agent",
      "missingStateKey": "settingsVoice.realtimeProviders.elevenLabs.agentMissing",
      "settingId": "agentId",
      "titleKey": "settingsVoice.realtimeProviders.elevenLabs.agentTitle",
      "updateActionId": "update-agent"
    },
    "providerId": "happier.voice.elevenlabs/realtime-elevenlabs",
    "resources": {
      "accountTitleKey": "settingsVoice.realtimeProviders.elevenLabs.openAccount",
      "apiKeysTitleKey": "settingsVoice.realtimeProviders.elevenLabs.manageApiKeys",
      "titleKey": "settingsVoice.realtimeProviders.elevenLabs.resourcesTitle"
    },
    "settingsSectionId": "voice.provider.realtime_elevenlabs"
  },
  {
    "providerId": "happier.voice.google/gemini-stt",
    "settingsSectionId": "voice.stt.google_gemini",
    "settingsSpec": {
      "credential": {
        "promptBodyKey": "settingsVoice.local.googleGeminiStt.apiKey.promptBody",
        "promptTitleKey": "settingsVoice.local.googleGeminiStt.apiKey.promptTitle",
        "titleKey": "settingsVoice.local.googleGeminiStt.apiKey.title"
      },
      "detailKey": "settingsVoice.local.googleGeminiStt.provider.detail",
      "fields": [
        {
          "fieldId": "model",
          "searchPlaceholderKey": "settingsVoice.local.googleGeminiStt.model.searchPlaceholder",
          "subtitleKey": "settingsVoice.local.googleGeminiStt.model.subtitle",
          "titleKey": "settingsVoice.local.googleGeminiStt.model.title"
        },
        {
          "autoSubtitleKey": "settingsVoice.local.googleGeminiStt.language.autoSubtitle",
          "autoTitleKey": "settingsVoice.local.googleGeminiStt.language.autoTitle",
          "fieldId": "language",
          "subtitleKey": "settingsVoice.local.googleGeminiStt.language.subtitle",
          "titleKey": "settingsVoice.local.googleGeminiStt.language.title"
        }
      ],
      "iconName": "google-logo",
      "subtitleKey": "settingsVoice.local.googleGeminiStt.provider.subtitle",
      "test": null,
      "titleKey": "settingsVoice.local.googleGeminiStt.provider.title"
    }
  },
  {
    "providerId": "happier.voice.google/google-cloud-tts",
    "settingsSectionId": "voice.tts.google_cloud",
    "settingsSpec": {
      "credential": {
        "promptBodyKey": "settingsVoice.local.googleCloudTts.apiKey.promptBody",
        "promptTitleKey": "settingsVoice.local.googleCloudTts.apiKey.promptTitle",
        "titleKey": "settingsVoice.local.googleCloudTts.apiKey.title"
      },
      "detailKey": "settingsVoice.local.googleCloudTts.provider.detail",
      "fields": [
        {
          "autoSubtitleKey": "settingsVoice.local.googleCloudTts.language.allSubtitle",
          "autoTitleKey": "settingsVoice.local.googleCloudTts.language.allTitle",
          "fieldId": "languageCode",
          "subtitleKey": "settingsVoice.local.googleCloudTts.language.subtitle",
          "titleKey": "settingsVoice.local.googleCloudTts.language.title"
        },
        {
          "fieldId": "voiceName",
          "searchPlaceholderKey": "settingsVoice.local.googleCloudTts.voice.searchPlaceholder",
          "subtitleKey": "settingsVoice.local.googleCloudTts.voice.subtitle",
          "titleKey": "settingsVoice.local.googleCloudTts.voice.title"
        },
        {
          "fieldId": "format",
          "subtitleKey": "settingsVoice.local.googleCloudTts.format.subtitle",
          "titleKey": "settingsVoice.local.googleCloudTts.format.title"
        },
        {
          "fieldId": "speakingRate",
          "promptBodyKey": "settingsVoice.local.googleCloudTts.speakingRate.promptBody",
          "promptTitleKey": "settingsVoice.local.googleCloudTts.speakingRate.promptTitle",
          "subtitleKey": "settingsVoice.local.googleCloudTts.speakingRate.subtitle",
          "titleKey": "settingsVoice.local.googleCloudTts.speakingRate.title"
        },
        {
          "fieldId": "pitch",
          "promptBodyKey": "settingsVoice.local.googleCloudTts.pitch.promptBody",
          "promptTitleKey": "settingsVoice.local.googleCloudTts.pitch.promptTitle",
          "subtitleKey": "settingsVoice.local.googleCloudTts.pitch.subtitle",
          "titleKey": "settingsVoice.local.googleCloudTts.pitch.title"
        }
      ],
      "iconName": "google-logo",
      "subtitleKey": "settingsVoice.local.googleCloudTts.provider.subtitle",
      "test": {
        "missingValueMessageKey": "settingsVoice.local.googleCloudTts.alerts.missingVoice"
      },
      "titleKey": "settingsVoice.local.googleCloudTts.provider.title"
    }
  },
  {
    "providerId": "happier.voice.openai/realtime-openai",
    "settingsSectionId": "voice.provider.realtime_openai"
  },
  {
    "providerId": "happier.voice.openai-compat/stt",
    "settingsSectionId": "voice.stt.openai_compat",
    "settingsSpec": {
      "credential": {
        "promptBodyKey": "settingsVoice.local.sttApiKeyDescription",
        "promptTitleKey": "settingsVoice.local.sttApiKeyTitle",
        "titleKey": "settingsVoice.local.sttApiKey"
      },
      "detailKey": "settingsVoice.local.openaiCompatStt.provider.detail",
      "fields": [
        {
          "fieldId": "baseUrl",
          "promptBodyKey": "settingsVoice.local.sttBaseUrlDescription",
          "promptTitleKey": "settingsVoice.local.sttBaseUrlTitle",
          "subtitleKey": "settingsVoice.local.sttBaseUrlDescription",
          "titleKey": "settingsVoice.local.sttBaseUrl"
        },
        {
          "fieldId": "model",
          "promptBodyKey": "settingsVoice.local.sttModelDescription",
          "promptTitleKey": "settingsVoice.local.sttModelTitle",
          "subtitleKey": "settingsVoice.local.sttModelSubtitle",
          "titleKey": "settingsVoice.local.sttModel"
        },
        {
          "fieldId": "language",
          "promptBodyKey": "settingsVoice.local.localNeuralStt.language.promptBody",
          "promptTitleKey": "settingsVoice.local.localNeuralStt.language.promptTitle",
          "subtitleKey": "settingsVoice.local.localNeuralStt.language.subtitle",
          "titleKey": "settingsVoice.local.localNeuralStt.language.title"
        }
      ],
      "iconName": "cloud",
      "subtitleKey": "settingsVoice.local.openaiCompatStt.provider.subtitle",
      "test": null,
      "titleKey": "settingsVoice.local.openaiCompatStt.provider.title"
    }
  },
  {
    "providerId": "happier.voice.openai-compat/tts",
    "settingsSectionId": "voice.tts.openai_compat",
    "settingsSpec": {
      "credential": {
        "promptBodyKey": "settingsVoice.local.ttsApiKeyDescription",
        "promptTitleKey": "settingsVoice.local.ttsApiKeyTitle",
        "titleKey": "settingsVoice.local.ttsApiKey"
      },
      "detailKey": "settingsVoice.local.openaiCompatTts.provider.detail",
      "fields": [
        {
          "fieldId": "baseUrl",
          "promptBodyKey": "settingsVoice.local.ttsBaseUrlDescription",
          "promptTitleKey": "settingsVoice.local.ttsBaseUrlTitle",
          "subtitleKey": "settingsVoice.local.ttsBaseUrlDescription",
          "titleKey": "settingsVoice.local.ttsBaseUrl"
        },
        {
          "fieldId": "maxInputCharacters",
          "subtitleKey": "OpenAI accepts 4,096 characters. For a custom endpoint, use its documented input limit.",
          "titleKey": "Endpoint input limit (characters)"
        },
        {
          "fieldId": "model",
          "promptBodyKey": "settingsVoice.local.ttsModelDescription",
          "promptTitleKey": "settingsVoice.local.ttsModelTitle",
          "subtitleKey": "settingsVoice.local.ttsModelSubtitle",
          "titleKey": "settingsVoice.local.ttsModel"
        },
        {
          "fieldId": "voiceName",
          "promptBodyKey": "settingsVoice.local.ttsVoiceDescription",
          "promptTitleKey": "settingsVoice.local.ttsVoiceTitle",
          "subtitleKey": "settingsVoice.local.ttsVoiceSubtitle",
          "titleKey": "settingsVoice.local.ttsVoice"
        },
        {
          "fieldId": "format",
          "subtitleKey": "settingsVoice.local.ttsFormatSubtitle",
          "titleKey": "settingsVoice.local.ttsFormat"
        }
      ],
      "iconName": "cloud",
      "subtitleKey": "settingsVoice.local.openaiCompatTts.provider.subtitle",
      "test": {
        "missingValueMessageKey": "settingsVoice.local.testTtsMissingBaseUrl"
      },
      "titleKey": "settingsVoice.local.openaiCompatTts.provider.title"
    }
  },
  {
    "providerId": "happier.voice.xai/realtime-grok",
    "settingsSectionId": "voice.provider.realtime_grok"
  }
] as const,
).map((presentation) => Object.freeze({ ...presentation,
  ...(BUNDLED_FIRST_PARTY_VOICE_SELECTION_OPTIONS[presentation.providerId]
    ? { selectionOptions: BUNDLED_FIRST_PARTY_VOICE_SELECTION_OPTIONS[presentation.providerId] } : {}),
})) satisfies readonly VoiceProviderPresentation[];
