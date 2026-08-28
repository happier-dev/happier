/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry map for first-party bundled
 * Agent UI descriptors and predecessor-scoped message metadata writers.
 *
 * It is split out from `generatedBundledPluginEntries.ts` to avoid import cycles
 * between agent UI behavior graphs, message compatibility, and registry maps.
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { CanonicalAgentId } from './registryCore';
import { CLAUDE_PREDECESSOR_MESSAGE_META_WRITER } from '@happier-dev/plugins-claude/ui/predecessor-message-meta';

export type BundledAgentUiBehaviorDescriptor = Readonly<{
    agentId: CanonicalAgentId;
    descriptor: Readonly<Record<string, unknown>>;
}>;

export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS: Readonly<
    Partial<Record<CanonicalAgentId, BundledAgentUiBehaviorDescriptor>>
> = Object.freeze({
    antigravity: Object.freeze({
        agentId: 'antigravity' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    auggie: Object.freeze({
        agentId: 'auggie' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": [
      {
        "chip": {
          "iconName": "magnifying-glass",
          "kind": "booleanOption",
          "offLabelKey": "agentInput.auggieIndexingChip.off",
          "onLabelKey": "agentInput.auggieIndexingChip.on",
          "optionStateKey": "allowIndexing"
        },
        "id": "auggie-allow-indexing",
        "slot": "newSession.agentInputExtraActionChips"
      }
    ]
  },
  "descriptorId": "auggie.uiBehavior.v1",
  "newSession": {
    "agentOptions": [
      {
        "key": "allowIndexing",
        "kind": "boolean",
        "spawnConfigOption": true
      }
    ]
  }
} as const),
    }),
    claude: Object.freeze({
        agentId: 'claude' as CanonicalAgentId,
        descriptor: Object.freeze({
  "askUserQuestion": {
    "dialogs": [
      {
        "dialogId": "switch_model",
        "terminalSecondaryAction": {
          "descriptionKey": "tools.askUserQuestion.attachedTerminalNotice.description",
          "kind": "openAttachedTerminal",
          "labelKey": "tools.askUserQuestion.attachedTerminalNotice.openTerminal"
        }
      },
      {
        "dialogId": "usage_limit",
        "terminalSecondaryAction": {
          "descriptionKey": "tools.askUserQuestion.attachedTerminalNotice.description",
          "kind": "openAttachedTerminal",
          "labelKey": "tools.askUserQuestion.attachedTerminalNotice.openTerminal"
        }
      },
      {
        "dialogId": "resume_choice",
        "settingMutation": {
          "allowedValues": [
            "resume_from_summary",
            "resume_full_session"
          ],
          "settingId": "claudeUnifiedTerminalResumeChoice"
        },
        "terminalSecondaryAction": {
          "descriptionKey": "tools.askUserQuestion.attachedTerminalNotice.description",
          "kind": "openAttachedTerminal",
          "labelKey": "tools.askUserQuestion.attachedTerminalNotice.openTerminal"
        }
      },
      {
        "dialogId": "safeguard_pause",
        "terminalSecondaryAction": {
          "descriptionKey": "tools.askUserQuestion.attachedTerminalNotice.description",
          "kind": "openAttachedTerminal",
          "labelKey": "tools.askUserQuestion.attachedTerminalNotice.openTerminal"
        }
      },
      {
        "dialogId": "effort_change",
        "terminalSecondaryAction": {
          "descriptionKey": "tools.askUserQuestion.attachedTerminalNotice.description",
          "kind": "openAttachedTerminal",
          "labelKey": "tools.askUserQuestion.attachedTerminalNotice.openTerminal"
        }
      },
      {
        "dialogId": "trust_folder",
        "settingMutation": {
          "allowedValues": [
            "always_trust_happier_workspaces",
            "always_reject_happier_workspaces"
          ],
          "settingId": "claudeUnifiedTerminalWorkspaceTrust"
        },
        "terminalSecondaryAction": {
          "descriptionKey": "tools.askUserQuestion.attachedTerminalNotice.description",
          "kind": "openAttachedTerminal",
          "labelKey": "tools.askUserQuestion.attachedTerminalNotice.openTerminal"
        }
      },
      {
        "dialogId": "unrecognized_confirmation",
        "terminalNotice": {
          "headerKey": "tools.askUserQuestion.attachedTerminalNotice.header",
          "questionKey": "tools.askUserQuestion.attachedTerminalNotice.question"
        },
        "terminalSecondaryAction": {
          "descriptionKey": "tools.askUserQuestion.attachedTerminalNotice.description",
          "kind": "openAttachedTerminal",
          "labelKey": "tools.askUserQuestion.attachedTerminalNotice.openTerminal"
        }
      }
    ]
  },
  "attachedSessionTerminal": {
    "supported": true
  },
  "components": {
    "slots": [
      {
        "id": "claude.subagentLaunchCards",
        "props": {
          "teamIds": {
            "kind": "subagentGroupKeys",
            "subagentKinds": [
              "agent_team_member"
            ]
          }
        },
        "slot": "sessionSubagents.launchCards",
        "surfaceId": "subagent-launch"
      },
      {
        "iconName": "people",
        "id": "claude.teammateDetailsTab",
        "resourceKind": "claudeSubagentLauncher",
        "slot": "sessionSubagents.teammateDetailsTab",
        "surfaceId": "subagent-details",
        "tab": {
          "keyPrefix": "claude-subagent-launcher",
          "subtitleKey": "session.subagents.panel.launchClaudeTeamsSubtitle",
          "titleKey": "session.subagents.panel.launchTeammateAction"
        }
      }
    ]
  },
  "contextWindow": {
    "defaultTokens": 200000,
    "modelRules": [
      {
        "descriptionIncludesAny": [
          "1 million",
          "1m context"
        ],
        "idSuffix": "[1m]",
        "tokens": 1000000
      }
    ],
    "observedUsageBumpTokens": [
      200000,
      1000000
    ],
    "trustObservedUsageBeyondKnown": true
  },
  "descriptorId": "claude.uiBehavior.v1",
  "externalSessions": {
    "browse": {
      "compatibleSource": {
        "optionalFields": [
          "configDir",
          "projectId"
        ],
        "sourceKind": "claudeConfig"
      },
      "linkEnsureRequestExtras": {
        "sourceFromCandidate": {
          "optionalFields": [
            "configDir",
            "projectId"
          ],
          "sourceKind": "claudeConfig"
        }
      },
      "order": 20,
      "sourceOptions": [
        {
          "key": "claude:default",
          "labelKey": "externalSessions.browseSourceClaudeDefault",
          "source": {
            "kind": "claudeConfig"
          }
        }
      ]
    },
    "sessionHandoff": {
      "clearMetadataKeys": [
        "claudeTranscriptPath",
        "claudeLastCheckpointId",
        "claudeLastAssistantUuid"
      ]
    }
  },
  "message": {
    "metaOverrides": [
      {
        "id": "reasoning-effort",
        "normalize": "trimLowercase",
        "targetKey": "reasoningEffort",
        "value": {
          "key": "reasoning_effort",
          "kind": "sessionConfigOptionOverride"
        }
      }
    ]
  },
  "pendingDelivery": {
    "custodyLabelKey": "session.pendingMessages.deliveryStatus.queuedInClaude",
    "interruptAndRun": true
  },
  "sessionComposer": {
    "nonSteerableWhileBusy": {
      "freshModelOverride": true,
      "metaKeys": [
        "reasoningEffort"
      ],
      "reason": "provider_config_change_refused",
      "sessionConfigOptionIds": [
        "reasoning_effort"
      ]
    }
  },
  "workState": {
    "editableGoals": {
      "capabilityDriven": true,
      "persistedGoalSnapshot": {
        "itemKind": "goal",
        "path": [
          "sessionWorkStateV1"
        ],
        "providerFields": [
          "agentId",
          "backendId"
        ]
      }
    }
  }
} as const),
    }),
    codex: Object.freeze({
        agentId: 'codex' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  },
  "contextWindow": {
    "defaultTokens": 372000,
    "modelRules": [
      {
        "idSuffix": "gpt-5.6-sol",
        "tokens": 372000
      },
      {
        "idSuffix": "gpt-5.6-terra",
        "tokens": 372000
      },
      {
        "idSuffix": "gpt-5.6-luna",
        "tokens": 372000
      },
      {
        "idSuffix": "gpt-5.5",
        "tokens": 272000
      },
      {
        "idSuffix": "gpt-5.4",
        "tokens": 272000
      },
      {
        "idSuffix": "gpt-5.4-mini",
        "tokens": 272000
      }
    ]
  },
  "externalSessions": {
    "browse": {
      "compatibleSource": {
        "optionalFields": [
          "home",
          "connectedServiceId",
          "connectedServiceProfileId",
          "connectedServiceGroupId",
          "homePath"
        ],
        "sourceKind": "codexHome"
      },
      "connectedServiceProfileSources": [
        {
          "detailSettingsKey": "connectedServicesProfileLabelByKey",
          "keyPrefix": "codex:connected-service",
          "labelKey": "externalSessions.browseSourceCodexConnectedServices",
          "labelParams": {
            "service": "OpenAI Codex"
          },
          "profileIdField": "connectedServiceProfileId",
          "serviceId": "openai-codex",
          "serviceIdField": "connectedServiceId",
          "source": {
            "home": "connectedService",
            "kind": "codexHome"
          }
        }
      ],
      "linkEnsureRequestExtras": {
        "runtimeDescriptorFromCandidate": {
          "agentExtra": {
            "owner": "codex",
            "runtimeHandleFields": [
              "backendMode",
              "providerSessionId",
              "home",
              "connectedServiceId",
              "connectedServiceProfileId",
              "connectedServiceGroupId",
              "homePath"
            ],
            "schemaId": "codex.agentRuntimeDescriptorExtra",
            "v": 1
          },
          "backendMode": {
            "values": [
              "acp",
              "appServer"
            ]
          },
          "sourceFields": [
            "home",
            "connectedServiceId",
            "connectedServiceProfileId",
            "connectedServiceGroupId",
            "homePath"
          ]
        },
        "sourceFromCandidate": {
          "optionalFields": [
            "home",
            "connectedServiceId",
            "connectedServiceProfileId",
            "connectedServiceGroupId",
            "homePath"
          ],
          "sourceKind": "codexHome"
        }
      },
      "lockedConnectedServiceSource": {
        "groupIdField": "connectedServiceGroupId",
        "keyPrefix": "codex:connected-service",
        "profileIdField": "connectedServiceProfileId",
        "serviceId": "openai-codex",
        "serviceIdField": "connectedServiceId",
        "source": {
          "home": "connectedService",
          "kind": "codexHome"
        }
      },
      "order": 10,
      "sourceOptions": [
        {
          "key": "codex:user",
          "labelKey": "externalSessions.browseSourceCodexUserHome",
          "source": {
            "home": "user",
            "kind": "codexHome"
          }
        }
      ]
    }
  },
  "guidance": {
    "includeInSessionGettingStartedCliExamples": true
  },
  "newSession": {
    "relevantInstallableDeps": [
      {
        "keys": [
          "codex-acp"
        ],
        "when": {
          "all": [
            {
              "kind": "experimentsEnabled"
            },
            {
              "any": [
                {
                  "aliases": {
                    "mcp": "mcp",
                    "mcp_resume": "acp"
                  },
                  "kind": "settingEquals",
                  "settingKey": "codexBackendMode",
                  "value": "acp"
                },
                {
                  "kind": "settingTrue",
                  "settingKey": "experimentalCodexAcp"
                }
              ]
            }
          ]
        }
      }
    ]
  },
  "payload": {
    "backendTransport": {
      "agentExtra": {
        "owner": "codex",
        "schemaId": "codex.agentRuntimeDescriptorExtra",
        "v": 1
      },
      "backendMode": {
        "aliases": {
          "mcp": "mcp",
          "mcp_resume": "acp"
        },
        "legacyExperimentalValue": "acp",
        "values": [
          "acp",
          "appServer"
        ]
      },
      "runtimeHandleFields": [
        "backendMode",
        "providerSessionId",
        "home",
        "connectedServiceId",
        "connectedServiceProfileId",
        "connectedServiceGroupId",
        "homePath"
      ]
    },
    "sessionExtras": {
      "aliases": {
        "mcp": "mcp",
        "mcp_resume": "acp"
      },
      "defaultValue": "appServer",
      "outputKey": "codexBackendMode",
      "settingKey": "codexBackendMode",
      "values": [
        "acp",
        "appServer"
      ]
    }
  },
  "permissions": {
    "footer": {
      "forceReadOnlyAfterStop": false,
      "stopHandling": "denyOnly",
      "supportsExecPolicyAmendment": true,
      "usePermissionUpdates": false
    }
  },
  "resume": {
    "experimentSwitches": [
      {
        "id": "resumeAcp",
        "when": {
          "aliases": {
            "mcp": "mcp",
            "mcp_resume": "acp"
          },
          "kind": "settingEquals",
          "settingKey": "codexBackendMode",
          "value": "acp"
        }
      }
    ]
  },
  "workState": {
    "editableGoals": {
      "activeModeValues": [
        "appServer"
      ],
      "activeWhenNoPersistedMode": true,
      "modeValues": [
        "acp",
        "appServer"
      ],
      "persistedGoalSnapshot": {
        "itemKind": "goal",
        "path": [
          "sessionWorkStateV1"
        ],
        "providerFields": [
          "agentId",
          "backendId"
        ]
      }
    }
  }
} as const),
    }),
    copilot: Object.freeze({
        agentId: 'copilot' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    cursor: Object.freeze({
        agentId: 'cursor' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    gemini: Object.freeze({
        agentId: 'gemini' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    grok: Object.freeze({
        agentId: 'grok' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    kilo: Object.freeze({
        agentId: 'kilo' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    kimi: Object.freeze({
        agentId: 'kimi' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    kiro: Object.freeze({
        agentId: 'kiro' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    ohMyPi: Object.freeze({
        agentId: 'ohMyPi' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  },
  "externalSessions": {
    "browse": {
      "compatibleSource": {
        "optionalFields": [
          "agentDir"
        ],
        "sourceKind": "ohMyPiAgentDir"
      },
      "linkEnsureRequestExtras": {
        "sourceFromCandidate": {
          "optionalFields": [
            "agentDir"
          ],
          "sourceKind": "ohMyPiAgentDir"
        }
      },
      "order": 25,
      "sourceOptions": [
        {
          "detail": "~/.omp/agent",
          "key": "ohMyPi:default-agent-dir",
          "labelKey": "agentInput.agent.ohMyPi",
          "source": {
            "kind": "ohMyPiAgentDir"
          }
        }
      ]
    }
  }
} as const),
    }),
    opencode: Object.freeze({
        agentId: 'opencode' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  },
  "descriptorId": "opencode.uiBehavior.v1",
  "externalSessions": {
    "browse": {
      "compatibleSource": {
        "optionalFields": [
          "baseUrl",
          "directory"
        ],
        "sourceKind": "opencodeServer"
      },
      "order": 30,
      "sourceOptions": [
        {
          "key": "opencode:default",
          "labelKey": "externalSessions.browseSourceOpenCodeDefault",
          "source": {
            "kind": "opencodeServer"
          }
        }
      ]
    }
  },
  "guidance": {
    "includeInSessionGettingStartedCliExamples": true
  },
  "newSession": {
    "transcriptStorageModesByBackendMode": {
      "acp": [
        "persisted"
      ],
      "server": [
        "persisted",
        "direct"
      ]
    }
  },
  "payload": {
    "environmentVariables": {
      "agentExtra": {
        "owner": "opencode",
        "runtimeHandleFields": [
          "backendMode",
          "providerSessionId",
          "serverBaseUrl",
          "serverBaseUrlExplicit"
        ],
        "schemaId": "opencode.agentRuntimeDescriptorExtra",
        "v": 1
      },
      "backendMode": {
        "defaultValue": "server",
        "envKey": "HAPPIER_OPENCODE_BACKEND_MODE",
        "legacyMetadataKey": "opencodeBackendMode",
        "runtimeDescriptorField": "backendMode",
        "settingKey": "opencodeBackendMode",
        "values": [
          "server",
          "acp"
        ]
      },
      "serverBaseUrl": {
        "allowedProtocols": [
          "http:",
          "https:"
        ],
        "byServerIdSettingKey": "opencodeServerBaseUrlByServerIdV1",
        "envKey": "HAPPIER_OPENCODE_SERVER_URL",
        "explicitEnvKey": "HAPPIER_OPENCODE_SERVER_URL_EXPLICIT",
        "legacyExplicitMetadataKey": "opencodeServerBaseUrlExplicit",
        "legacyMetadataKey": "opencodeServerBaseUrl",
        "originOnly": true,
        "rejectCredentials": true,
        "runtimeDescriptorExplicitField": "serverBaseUrlExplicit",
        "runtimeDescriptorField": "serverBaseUrl",
        "settingKey": "opencodeServerBaseUrl"
      }
    }
  }
} as const),
    }),
    pi: Object.freeze({
        agentId: 'pi' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  },
  "descriptorId": "pi.uiBehavior.v1"
} as const),
    }),
    coderabbit: Object.freeze({
        agentId: 'coderabbit' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
    deepsec: Object.freeze({
        agentId: 'deepsec' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  }
} as const),
    }),
});

export type BundledAgentPredecessorMessageMetaWriter = Readonly<{
    buildPredecessorMessageMeta(settings: Readonly<Record<string, unknown>>):
        Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
}>;

export const BUNDLED_CANONICAL_AGENT_PREDECESSOR_MESSAGE_META_WRITERS: Readonly<
    Partial<Record<CanonicalAgentId, BundledAgentPredecessorMessageMetaWriter>>
> = Object.freeze({
    claude: CLAUDE_PREDECESSOR_MESSAGE_META_WRITER,
});
