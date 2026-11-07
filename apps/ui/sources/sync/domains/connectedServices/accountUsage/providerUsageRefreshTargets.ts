import { resolveAgentIdFromSessionMetadata, type AgentId } from '@happier-dev/agents';
import { readProviderAccountUsageRecordIdsFromMetadata } from '@happier-dev/protocol';

export type ProviderUsageRefreshTarget = Readonly<{
    connectedProfileRef: Readonly<{ serviceId: string; profileId: string }> | null;
    recordIds: readonly string[];
}>;

/** Shared native account selection for displayed gauges and refresh requests. */
export function selectLatestProviderUsageRecordIdsByAgent(sessions: ReadonlyArray<Readonly<{ metadata: unknown }>>) {
    const records = new Map<AgentId, string[]>();
    for (const session of sessions) {
        const providerId = resolveAgentIdFromSessionMetadata(session.metadata);
        if (!providerId || (records.get(providerId)?.length ?? 0) > 0) continue;
        const recordIds = readProviderAccountUsageRecordIdsFromMetadata(session.metadata);
        // A native provider remains configured even when it cannot report quota figures.
        // Keep looking through older sessions for its latest published account refs.
        records.set(providerId, recordIds);
    }
    return records;
}

/** Connected profiles and the latest native usage source per provider, matching the displayed accounts. */
export function collectConfiguredProviderUsageRefreshTargets(params: Readonly<{
    connectedServices: ReadonlyArray<Readonly<{ serviceId: string; profiles: ReadonlyArray<Readonly<{ profileId: string }>> }>>;
    /** The latest native usage record ids per provider, as selected by selectLatestProviderUsageRecordIdsByAgent. */
    latestRecordIdsByAgent: ReadonlyMap<AgentId, readonly string[]>;
}>): readonly ProviderUsageRefreshTarget[] {
    const targets: ProviderUsageRefreshTarget[] = [];
    for (const service of params.connectedServices) {
        for (const profile of service.profiles) {
            const profileId = profile.profileId.trim();
            if (profileId) targets.push({ connectedProfileRef: { serviceId: service.serviceId, profileId }, recordIds: [] });
        }
    }
    for (const recordIds of params.latestRecordIdsByAgent.values()) {
        if (recordIds.length > 0) targets.push({ connectedProfileRef: null, recordIds: [...recordIds] });
    }
    return targets;
}

/**
 * A primitive signature of the latest record ids, so a store subscription can compare it by value and
 * stay quiet while unrelated session fields (streaming updates, titles) change. Agent and record ids
 * contain only letters, digits, `_` and `-`, so `|`, `:` and `,` are safe separators.
 */
export function serializeLatestProviderUsageRecordIds(records: ReadonlyMap<AgentId, readonly string[]>): string {
    return [...records].map(([agentId, recordIds]) => `${agentId}:${recordIds.join(',')}`).join('|');
}

export function parseLatestProviderUsageRecordIds(signature: string): ReadonlyMap<AgentId, readonly string[]> {
    const records = new Map<AgentId, readonly string[]>();
    for (const entry of signature.split('|')) {
        const [agentId, ids] = entry.split(':');
        if (agentId && ids !== undefined) records.set(agentId as AgentId, ids ? ids.split(',') : []);
    }
    return records;
}
