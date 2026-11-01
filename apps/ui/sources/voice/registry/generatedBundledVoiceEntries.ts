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
import type { BundledVoiceManifestContribution, BundledVoiceManifestProjection, BundledVoiceManifestProjectionInput } from './bundledVoiceManifestProjection';
import type { VoiceProviderPresentation } from './voiceProviderPresentation';
import { createBundledVoiceProviderPresentations } from './bundledVoiceManifestProjection';
import { BUNDLED_FIRST_PARTY_VOICE_SELECTION_OPTIONS } from '@happier-dev/protocol/voice/settings/generatedBundledVoiceSelectionOptions';


export const CODEX_BUNDLED_VOICE_MANIFEST = Object.freeze<BundledVoiceManifestProjectionInput>(
{
  "contributes": {
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
        "description": {
          "fallback": "Speak directly with the active Codex agent session.",
          "key": "settingsVoice.mode.codexRealtimeSubtitle"
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
        "title": "Codex Realtime Voice"
      }
    ]
  },
  "id": "happier.agent.codex"
} satisfies BundledVoiceManifestProjectionInput,
) as BundledVoiceManifestProjection;

export const ELEVENLABS_BUNDLED_VOICE_MANIFEST = Object.freeze<BundledVoiceManifestProjectionInput>(
{
  "contributes": {
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
        "description": {
          "fallback": "Talk with ElevenLabs voices.",
          "key": "settingsVoice.realtimeProviders.elevenLabs.description"
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
    ]
  },
  "id": "happier.voice.elevenlabs"
} satisfies BundledVoiceManifestProjectionInput,
) as BundledVoiceManifestProjection;

export const GOOGLE_BUNDLED_VOICE_MANIFEST = Object.freeze<BundledVoiceManifestProjectionInput>(
{
  "contributes": {
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
    ]
  },
  "id": "happier.voice.google"
} satisfies BundledVoiceManifestProjectionInput,
) as BundledVoiceManifestProjection;

export const OPENAI_BUNDLED_VOICE_MANIFEST = Object.freeze<BundledVoiceManifestProjectionInput>(
{
  "contributes": {
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
        "description": {
          "fallback": "Uses your OpenAI account or API key",
          "key": "settingsVoice.realtimeProviders.openai.description"
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
                "options": [
                  {
                    "id": "alloy",
                    "title": "Alloy"
                  },
                  {
                    "id": "ash",
                    "title": "Ash"
                  },
                  {
                    "id": "ballad",
                    "title": "Ballad"
                  },
                  {
                    "id": "coral",
                    "title": "Coral"
                  },
                  {
                    "id": "echo",
                    "title": "Echo"
                  },
                  {
                    "id": "sage",
                    "title": "Sage"
                  },
                  {
                    "id": "shimmer",
                    "title": "Shimmer"
                  },
                  {
                    "id": "verse",
                    "title": "Verse"
                  },
                  {
                    "id": "marin",
                    "title": "Marin"
                  },
                  {
                    "id": "cedar",
                    "title": "Cedar"
                  }
                ],
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
    ]
  },
  "id": "happier.voice.openai"
} satisfies BundledVoiceManifestProjectionInput,
) as BundledVoiceManifestProjection;

export const OPENAI_COMPAT_BUNDLED_VOICE_MANIFEST = Object.freeze<BundledVoiceManifestProjectionInput>(
{
  "contributes": {
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
    ]
  },
  "id": "happier.voice.openai-compat"
} satisfies BundledVoiceManifestProjectionInput,
) as BundledVoiceManifestProjection;

export const XAI_BUNDLED_VOICE_MANIFEST = Object.freeze<BundledVoiceManifestProjectionInput>(
{
  "contributes": {
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
        "description": {
          "fallback": "Uses your xAI API key",
          "key": "settingsVoice.realtimeProviders.xai.description"
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
    ]
  },
  "id": "happier.voice.xai"
} satisfies BundledVoiceManifestProjectionInput,
) as BundledVoiceManifestProjection;

export const BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS = Object.freeze([
  ...projectBundledVoiceManifestContributions(CODEX_BUNDLED_VOICE_MANIFEST),
  ...projectBundledVoiceManifestContributions(ELEVENLABS_BUNDLED_VOICE_MANIFEST),
  ...projectBundledVoiceManifestContributions(GOOGLE_BUNDLED_VOICE_MANIFEST),
  ...projectBundledVoiceManifestContributions(OPENAI_BUNDLED_VOICE_MANIFEST),
  ...projectBundledVoiceManifestContributions(OPENAI_COMPAT_BUNDLED_VOICE_MANIFEST),
  ...projectBundledVoiceManifestContributions(XAI_BUNDLED_VOICE_MANIFEST),
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
