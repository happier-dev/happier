import { AGENT_IDS, resolveAgentIdFromFlavor, type AgentId } from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { SessionSubagentAutoRecipientContext } from '@/sync/domains/session/subagents/autoRecipient/types';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';

import { CLAUDE_SESSION_PROVIDER_BEHAVIOR } from './claude/claudeSessionProviderBehavior';
import type { ProviderParticipantSnapshot, SessionProviderBehavior } from './sessionProviderBehaviorTypes';

const SESSION_PROVIDER_BEHAVIORS: Readonly<Partial<Record<AgentId, SessionProviderBehavior>>> = Object.freeze({
    claude: CLAUDE_SESSION_PROVIDER_BEHAVIOR,
});

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
        const snapshot = behavior.participants?.deriveSnapshot?.(params);
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
        const ids = behavior.participants?.deriveSidechainIds?.(params) ?? [];
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
        const targets = behavior.participants?.deriveTargets?.(params) ?? [];
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
        const derived = behavior.subagents?.deriveSubagents?.(params) ?? [];
        subagents.push(...derived);
    }
    return subagents;
}

export function resolveProviderSessionSubagentAutoRecipient(
    context: SessionSubagentAutoRecipientContext,
): ReturnType<NonNullable<NonNullable<SessionProviderBehavior['subagents']>['resolveAutoRecipient']>> {
    const flavor = typeof context.session.metadata?.flavor === 'string' ? context.session.metadata.flavor : null;
    for (const behavior of listSessionProviderBehaviors({ flavor, metadata: context.session.metadata })) {
        const recipient = behavior.subagents?.resolveAutoRecipient?.(context);
        if (recipient) return recipient;
    }
    return null;
}

export function shouldIgnoreProviderSessionSubagentActivityPreviewText(params: Readonly<{
    subagent: SessionSubagent;
    text: string;
}>): boolean {
    for (const behavior of listSessionProviderBehaviors({ flavor: null })) {
        if (behavior.subagents?.shouldIgnoreActivityPreviewText?.(params) === true) {
            return true;
        }
    }
    return false;
}
