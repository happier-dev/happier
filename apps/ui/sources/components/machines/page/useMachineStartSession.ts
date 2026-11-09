import * as React from 'react';

import { useNewSessionEntryRouter as useRouter } from '@/components/sessions/new/navigation/newSessionEntry';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

/**
 * Start a session on exactly this machine (the page header's Start session, and the empty Processes tab's
 * "Start a session on <machine>"): one owner, so both open the same seeded draft in the same account scope.
 */
export function useMachineStartSession(target: Readonly<{ serverId?: string | null; machineId?: string | null }>): () => void {
    const router = useRouter();
    const activeAccountScope = useActiveServerAccountScope();
    return React.useCallback(() => {
        const targetServerId = String(target.serverId ?? '').trim();
        if (!target.machineId || !targetServerId || !activeAccountScope) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, activeAccountScope)) return;
        seedAndOpenNewSession({
            seed: { placement: { kind: 'exactTarget', serverId: targetServerId, machineId: target.machineId } },
            scope: activeAccountScope,
            isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId }) => {
                router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }) });
            },
        });
    }, [activeAccountScope, router, target.machineId, target.serverId]);
}
