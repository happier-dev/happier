import * as React from 'react';

import {
    getCachedServerRetentionPolicy,
    getServerRetentionPolicy,
} from '@/sync/api/capabilities/serverRetentionPolicyClient';
import type { ServerRetentionPolicyView } from '@/sync/domains/server/retention/serverRetentionPolicy';

function normalizeServerIds(serverIds: ReadonlyArray<string>): string[] {
    return Array.from(new Set(serverIds.map((value) => String(value).trim()).filter(Boolean)));
}

export function useServerRetentionPolicies(serverIds: ReadonlyArray<string>): Readonly<Record<string, ServerRetentionPolicyView | null>> {
    const normalizedServerIds = React.useMemo(
        () => normalizeServerIds(serverIds),
        [serverIds.join('\u0000')],
    );
    const [policies, setPolicies] = React.useState<Readonly<Record<string, ServerRetentionPolicyView | null>>>(() =>
        Object.fromEntries(normalizedServerIds.map((id) => [id, getCachedServerRetentionPolicy(id)])),
    );

    React.useEffect(() => {
        let active = true;
        setPolicies(Object.fromEntries(normalizedServerIds.map((id) => [id, getCachedServerRetentionPolicy(id)])));
        void Promise.all(normalizedServerIds.map(async (id) => [id, await getServerRetentionPolicy({ serverId: id })] as const))
            .then((entries) => {
                if (active) setPolicies(Object.fromEntries(entries));
            });
        return () => {
            active = false;
        };
    }, [normalizedServerIds]);

    return policies;
}
