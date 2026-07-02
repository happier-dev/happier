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

export type BundledAgentUiBehaviorDescriptor = Readonly<{
    agentId: CanonicalAgentId;
    descriptor: Readonly<Record<string, unknown>>;
}>;

export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS: Readonly<
    Partial<Record<CanonicalAgentId, BundledAgentUiBehaviorDescriptor>>
> = Object.freeze({
    auggie: Object.freeze({
        agentId: 'auggie' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
  },
  "descriptorId": "auggie.uiBehavior.v1",
  "newSessionOptions": [
    {
      "id": "auggie.allowIndexing",
      "stateKey": "allowIndexing"
    }
  ]
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
  "descriptorId": "claude.uiBehavior.v1",
  "externalSessions": {
    "browseDescriptorId": "claude.externalSessions.browse.v1",
    "sessionHandoffDescriptorId": "claude.sessionHandoff.v1"
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
  }
} as const),
    }),
    codex: Object.freeze({
        agentId: 'codex' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
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
    ohMyPi: Object.freeze({
        agentId: 'ohMyPi' as CanonicalAgentId,
        descriptor: Object.freeze({
  "components": {
    "slots": []
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
    "sessionHandoffDescriptorId": "opencode.sessionHandoff.v1",
    "supportsBackgroundFollow": false
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
        "httpLoopbackOnly": true,
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
});

export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES: Readonly<
    Partial<Record<CanonicalAgentId, AgentUiBehavior>>
> = Object.freeze({});
