import * as React from 'react';

import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

/**
 * Start a session on exactly this machine (the page header's Start session, and the empty Processes tab's
 * "Start a session on <machine>"): one owner, so both open the same seeded draft in the same account scope.
 */
export function useMachineStartSession(target: Readonly<{ serverId?: string | null; machineId?: string | null }>): () => Promise<void> {
    const activeAccountScope = useActiveServerAccountScope();
    return React.useCallback(async () => {
        const targetServerId = String(target.serverId ?? '').trim();
        if (!target.machineId || !targetServerId || !activeAccountScope) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, activeAccountScope)) return;
        await openSessionAuthoringAction({
            seed: { placement: { kind: 'exactTarget', serverId: targetServerId, machineId: target.machineId } },
        }, lifetime);
    }, [activeAccountScope, target.machineId, target.serverId]);
}
