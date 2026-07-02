/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry map for first-party bundled
 * agent session provider behaviors.
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { CanonicalAgentId } from './registryCore';
import type { SessionProviderBehavior } from '@/sync/domains/session/providers/sessionProviderBehaviorTypes';

export type BundledSessionProviderBehaviorDescriptor = Readonly<{
    agentId: CanonicalAgentId;
    descriptor: Readonly<Record<string, unknown>>;
}>;

export const BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIOR_DESCRIPTORS: Readonly<
    Partial<Record<CanonicalAgentId, BundledSessionProviderBehaviorDescriptor>>
> = Object.freeze({
    claude: Object.freeze({
        agentId: 'claude' as CanonicalAgentId,
        descriptor: Object.freeze({
  "autoRecipientPolicyId": "claude.teamMemberAutoRecipient.v1",
  "participantDescriptorId": "claude.teamParticipants.v1",
  "providerBehavior": {
    "agentTeam": {
      "configTeamPath": {
        "filename": "config.json",
        "rootDirectory": ".claude",
        "teamsDirectory": "teams"
      },
      "flavorAliases": [
        "claude"
      ],
      "kind": "session.agentTeamBehavior.v1",
      "lifecycleEvents": {
        "ignoreActivityPreview": [
          "idle_notification",
          "shutdown_approved"
        ],
        "shutdownApproved": "shutdown_approved"
      },
      "providerLabel": "Claude",
      "snapshotKey": "claudeTeam",
      "tools": {
        "activeTeamFallbackSubagentSpawn": [
          "Agent"
        ],
        "configMutation": [
          "Edit",
          "Write"
        ],
        "subagentSpawn": [
          "Agent",
          "Task"
        ],
        "teamCreate": [
          "AgentTeamCreate",
          "TeamCreate"
        ],
        "teamDelete": [
          "AgentTeamDelete",
          "TeamDelete"
        ],
        "teamSendMessage": [
          "AgentTeamSendMessage",
          "TeamSendMessage"
        ]
      }
    },
    "kind": "session.providerBehavior.v1"
  },
  "providerBehaviorDescriptorId": "claude.sessionProviderBehavior.v1",
  "subagentDescriptorId": "claude.teamSubagents.v1",
  "visibleMessages": {
    "excludeJsonEventTypes": [
      "idle_notification",
      "shutdown_approved"
    ],
    "fallbackToolNames": [
      "Agent",
      "Task"
    ],
    "kind": "session.visibleMessages.v1",
    "subagentKinds": [
      "agent_team_member"
    ]
  }
} as const),
    }),
});

export const BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIORS: Readonly<
    Partial<Record<CanonicalAgentId, SessionProviderBehavior>>
> = Object.freeze({});
