import { AGENT_IDS, resolveAgentIdFromFlavor, type AgentId } from '@/agents/registry/registryCore';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { SessionSubagentAutoRecipientContext } from '@/sync/domains/session/subagents/autoRecipient/types';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIOR_DESCRIPTORS,
    BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIORS,
} from '@/agents/registry/generatedBundledPluginEntries.sessionProviderBehaviors';

import type { ProviderParticipantSnapshot, SessionProviderBehavior } from './sessionProviderBehaviorTypes';
import { createSessionProviderBehaviorFromDescriptor } from './sessionProviderBehaviorDescriptors';

const SESSION_PROVIDER_BEHAVIORS: Readonly<Partial<Record<AgentId, SessionProviderBehavior>>> = Object.freeze(
    Object.fromEntries(
        AGENT_IDS.map((agentId) => {
            const descriptor = BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIOR_DESCRIPTORS[agentId]?.descriptor;
            const descriptorBehavior = descriptor
                ? createSessionProviderBehaviorFromDescriptor({
                    kind: 'plugin.ui.v1',
                    pluginId: agentId,
                    agentId,
                    version: 1,
                    session: descriptor,
                }).behavior
                : {};
            const fallbackBehavior = BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIORS[agentId] ?? {};
            const behavior = {
                ...descriptorBehavior,
                ...fallbackBehavior,
                participants: {
                    ...(descriptorBehavior.participants ?? {}),
                    ...(fallbackBehavior.participants ?? {}),
                },
                subagents: {
                    ...(descriptorBehavior.subagents ?? {}),
                    ...(fallbackBehavior.subagents ?? {}),
                },
            };
            return [agentId, behavior] as const;
        }),
    ),
);

function listSessionProviderBehaviors(params: Readonly<{ flavor: string | null; metadata?: unknown }>): readonly SessionProviderBehavior[] {
    const primaryAgentId = resolveAgentIdFromSessionMetadata(params.metadata) ?? resolveAgentIdFromFlavor(params.flavor);
    const orderedBehaviors: SessionProviderBehavior[] = [];

    if (primaryAgentId) {
        const primaryBehavior = SESSION_PROVIDER_BEHAVIORS[primaryAgentId];
        if (primaryBehavior) orderedBehaviors.push(primaryBehavior);
    }

    for (const agentId of AGENT_IDS) {
        if (agentId === primaryAgentId) continue;
        const behavior = SESSION_PROVIDER_BEHAVIORS[agentId];
        if (!behavior) continue;
        orderedBehaviors.push(behavior);
    }

    return orderedBehaviors;
}

export function deriveProviderParticipantSnapshot(params: Readonly<{
    flavor: string | null;
    messages: readonly Message[];
}>): ProviderParticipantSnapshot {
    const snapshots: Record<string, unknown> = {};
    for (const behavior of listSessionProviderBehaviors({ flavor: params.flavor })) {
        let snapshot: ProviderParticipantSnapshot | null | undefined;
        try {
            snapshot = behavior.participants?.deriveSnapshot?.(params);
        } catch {
            snapshot = null;
        }
        if (!snapshot) continue;
        Object.assign(snapshots, snapshot);
    }
    return snapshots;
}

export function deriveProviderParticipantSidechainIds(params: Readonly<{
    flavor: string | null;
    messages: readonly Message[];
}>): readonly string[] {
    const sidechainIds = new Set<string>();
    for (const behavior of listSessionProviderBehaviors({ flavor: params.flavor })) {
        let ids: readonly string[] = [];
        try {
            ids = behavior.participants?.deriveSidechainIds?.(params) ?? [];
        } catch {
            ids = [];
        }
        for (const id of ids) {
            const normalized = typeof id === 'string' ? id.trim() : '';
            if (normalized) sidechainIds.add(normalized);
        }
    }
    return [...sidechainIds];
}

export function deriveProviderParticipantTargets(params: Readonly<{
    session: Session;
    messages: readonly Message[];
    currentTargets: readonly SessionParticipantTarget[];
}>): readonly SessionParticipantTarget[] {
    const flavor = typeof params.session.metadata?.flavor === 'string' ? params.session.metadata.flavor : null;
    const extras: SessionParticipantTarget[] = [];
    const seenKeys = new Set(params.currentTargets.map((target) => target.key));

    for (const behavior of listSessionProviderBehaviors({ flavor, metadata: params.session.metadata })) {
        let targets: readonly SessionParticipantTarget[] = [];
        try {
            targets = behavior.participants?.deriveTargets?.(params) ?? [];
        } catch {
            targets = [];
        }
        for (const target of targets) {
            if (seenKeys.has(target.key)) continue;
            seenKeys.add(target.key);
            extras.push(target);
        }
    }

    return extras;
}

export function deriveProviderSessionSubagents(params: Readonly<{
    flavor: string | null;
    messages: readonly Message[];
}>): readonly SessionSubagent[] {
    const subagents: SessionSubagent[] = [];
    for (const behavior of listSessionProviderBehaviors({ flavor: params.flavor })) {
        let derived: readonly SessionSubagent[] = [];
        try {
            derived = behavior.subagents?.deriveSubagents?.(params) ?? [];
        } catch {
            derived = [];
        }
        subagents.push(...derived);
    }
    return subagents;
}

export function resolveProviderSessionSubagentAutoRecipient(
    context: SessionSubagentAutoRecipientContext,
): ReturnType<NonNullable<NonNullable<SessionProviderBehavior['subagents']>['resolveAutoRecipient']>> {
    const flavor = typeof context.session.metadata?.flavor === 'string' ? context.session.metadata.flavor : null;
    for (const behavior of listSessionProviderBehaviors({ flavor, metadata: context.session.metadata })) {
        let recipient: ReturnType<NonNullable<NonNullable<SessionProviderBehavior['subagents']>['resolveAutoRecipient']>> = null;
        try {
            recipient = behavior.subagents?.resolveAutoRecipient?.(context) ?? null;
        } catch {
            recipient = null;
        }
        if (recipient) return recipient;
    }
    return null;
}

export function shouldIgnoreProviderSessionSubagentActivityPreviewText(params: Readonly<{
    subagent: SessionSubagent;
    text: string;
}>): boolean {
    for (const behavior of listSessionProviderBehaviors({ flavor: null })) {
        let shouldIgnore = false;
        try {
            shouldIgnore = behavior.subagents?.shouldIgnoreActivityPreviewText?.(params) === true;
        } catch {
            shouldIgnore = false;
        }
        if (shouldIgnore) {
            return true;
        }
    }
    return false;
}
