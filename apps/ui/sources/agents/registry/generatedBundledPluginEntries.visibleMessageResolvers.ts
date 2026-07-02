/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry list for first-party bundled
 * session subagent visible-message resolvers.
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { SessionSubagentVisibleMessagesResolver } from '@/sync/domains/session/subagents/visibleMessages/types';

export type BundledSessionSubagentVisibleMessageDescriptor = Readonly<{
    agentId: string;
    descriptor: Readonly<Record<string, unknown>>;
}>;

export type BundledSessionSubagentVisibleMessageRegistryEntry = Readonly<{
    agentId: string;
    resolveVisibleMessages: SessionSubagentVisibleMessagesResolver;
}>;

export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS: readonly BundledSessionSubagentVisibleMessageDescriptor[] = Object.freeze([
    Object.freeze({
        agentId: 'claude',
        descriptor: Object.freeze({
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
} as const),
    }),
]);

export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY: readonly BundledSessionSubagentVisibleMessageRegistryEntry[] = Object.freeze([
]);
