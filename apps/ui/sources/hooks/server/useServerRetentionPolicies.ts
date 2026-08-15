import * as React from 'react';

import { getCachedServerRetentionPolicy, getServerRetentionPolicy } from '@/sync/api/capabilities/serverRetentionPolicyClient';
import type { ServerRetentionPolicyView } from '@/sync/domains/server/retention/serverRetentionPolicy';
import { fireAndForget } from '@/utils/system/fireAndForget';

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

export function useServerRetentionPolicies(serverIds: ReadonlyArray<string>): Readonly<Record<string, ServerRetentionPolicyView | null>> {
    const normalizedServerIds = React.useMemo(
        () => normalizeServerIds(serverIds),
        [serverIds.join('\u0000')],
    );
    const [policies, setPolicies] = React.useState<Readonly<Record<string, ServerRetentionPolicyView | null>>>({});

    React.useEffect(() => {
        let cancelled = false;
        const initial: Record<string, ServerRetentionPolicyView | null> = {};
        for (const serverId of normalizedServerIds) {
            initial[serverId] = getCachedServerRetentionPolicy(serverId);
        }
        setPolicies(initial);
        fireAndForget((async () => {
            const entries = await Promise.all(normalizedServerIds.map(async (serverId) => (
                [serverId, await getServerRetentionPolicy({ serverId })] as const
            )));
            if (!cancelled) setPolicies(Object.fromEntries(entries));
        })(), { tag: 'useServerRetentionPolicies.load' });
        return () => { cancelled = true; };
    }, [normalizedServerIds]);

    return policies;
}
