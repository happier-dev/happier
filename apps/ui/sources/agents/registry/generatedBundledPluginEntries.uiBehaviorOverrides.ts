/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry map for first-party bundled
 * agent UI behavior overrides.
 *
 * It is split out from `generatedBundledPluginEntries.ts` to avoid import cycles
 * between agent UI behavior graphs and the core registry maps.
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { CanonicalAgentId } from './registryCore';
import type { AgentUiBehavior } from './registryUiBehavior';
import { AUGGIE_UI_BEHAVIOR_OVERRIDE } from '@happier-dev/plugins-auggie/ui/behavior';
import { CLAUDE_UI_BEHAVIOR_OVERRIDE } from '@happier-dev/plugins-claude/ui/behavior';
import { CODEX_UI_BEHAVIOR_OVERRIDE } from '@happier-dev/plugins-codex/ui/behavior';

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
        "componentId": "firstParty.auggie.allowIndexingChip",
        "id": "auggie.allowIndexingChip",
        "props": {
          "optionStateKey": "allowIndexing"
        },
        "slot": "newSession.agentInputExtraActionChips"
      }
    ]
  },
  "descriptorId": "auggie.uiBehavior.v1"
} as const),
    }),
    claude: Object.freeze({
        agentId: 'claude' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": [
      {
        "componentId": "firstParty.claude.subagentLaunchCards",
        "id": "claude.subagentLaunchCards",
        "props": {
          "teamIds": {
            "kind": "subagentGroupKeys",
            "subagentKinds": [
              "agent_team_member"
            ]
          }
        },
        "slot": "sessionSubagents.launchCards"
      },
      {
        "componentId": "firstParty.claude.teammateDetailsTab",
        "iconName": "people",
        "id": "claude.teammateDetailsTab",
        "resourceKind": "claudeSubagentLauncher",
        "slot": "sessionSubagents.teammateDetailsTab",
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
    "browseDescriptorId": "claude.externalSessions.browse.v1",
    "sessionHandoff": {
      "clearMetadataKeys": [
        "claudeTranscriptPath",
        "claudeLastCheckpointId",
        "claudeLastAssistantUuid"
      ]
    },
    "sessionHandoffDescriptorId": "claude.sessionHandoff.v1"
  },
  "mcpServers": {
    "supportsDetectedConfigScan": true
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
      },
      "providerId": "claude"
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
          "legacyModeOutputKey": "codexBackendMode",
          "providerId": "codex",
          "runtimeDescriptorOutputKey": "runtimeDescriptorV1",
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
  "mcpServers": {
    "supportsDetectedConfigScan": true
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
                    "mcp": "appServer",
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
    "sessionExtras": {
      "outputKey": "codexBackendMode",
      "providerId": "codex",
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
            "mcp": "appServer",
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
      },
      "providerId": "codex"
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
    },
    "browseDescriptorId": "opencode.externalSessions.browse.v1",
    "sessionHandoffDescriptorId": "opencode.sessionHandoff.v1"
  },
  "guidance": {
    "includeInSessionGettingStartedCliExamples": true
  },
  "mcpServers": {
    "supportsDetectedConfigScan": true
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
      "providerId": "opencode",
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

export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES: Readonly<
    Partial<Record<CanonicalAgentId, AgentUiBehavior>>
> = Object.freeze({
    auggie: AUGGIE_UI_BEHAVIOR_OVERRIDE,
    claude: CLAUDE_UI_BEHAVIOR_OVERRIDE,
    codex: CODEX_UI_BEHAVIOR_OVERRIDE,
});
