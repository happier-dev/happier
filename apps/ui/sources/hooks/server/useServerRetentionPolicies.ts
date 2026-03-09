import * as React from 'react';

import { useServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { readServerRetentionPolicy, type ServerRetentionPolicy } from '@/sync/domains/server/retention/serverRetentionPolicy';

function normalizeServerIds(serverIds: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const value of serverIds) {
        const serverId = String(value).trim();
        if (!serverId || seen.has(serverId)) continue;
        seen.add(serverId);
        normalized.push(serverId);
    }

    return normalized;
}

export function useServerRetentionPolicies(serverIds: ReadonlyArray<string>): Readonly<Record<string, ServerRetentionPolicy | null>> {
    const normalizedServerIds = React.useMemo(
        () => normalizeServerIds(serverIds),
        [serverIds.join('\u0000')],
    );
    const snapshot = useServerFeaturesMainSelectionSnapshot(normalizedServerIds, { enabled: normalizedServerIds.length > 0 });

    return React.useMemo(() => {
        const policies: Record<string, ServerRetentionPolicy | null> = {};
        for (const serverId of normalizedServerIds) {
            const features = snapshot.snapshotsByServerId[serverId];
            policies[serverId] = features?.status === 'ready' ? readServerRetentionPolicy(features.features) : null;
        }
        return policies;
    }, [normalizedServerIds, snapshot]);
}
