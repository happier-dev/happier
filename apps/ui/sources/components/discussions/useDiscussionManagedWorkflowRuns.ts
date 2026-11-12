import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import * as React from 'react';
import { useContextManagedWorkflowRuns } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { discussionWorkflowRunListFilterId, workflowRunListWindowStoreKey } from '@/sync/store/domains/workflowRuns';

/** Demand-mounted timeline data, including Runs that have not published their first reply yet. */
export function useDiscussionManagedWorkflowRuns(params: Readonly<{
    discussion: DiscussionAddressV1 | null;
    accountLifetime: ServerAccountScopeLifetime;
    enabled?: boolean;
}>) {
    const { accountLifetime, discussion } = params;
    const state = useContextManagedWorkflowRuns({ resource: discussion ? { kind: 'discussion', id: discussion.discussionId } : null,
        serverId: discussion?.serverId ?? accountLifetime.scope.serverId, accountLifetime,
        enabled: discussion !== null && params.enabled !== false && areServerProfileIdentifiersEquivalent(accountLifetime.scope.serverId, discussion.serverId) });
    const onStarted = useDiscussionWorkflowRunStarted(params);
    return { ...state, onStarted };
}

/** Acknowledged Starts join the same relation window that reloads read from storage. */
export function useDiscussionWorkflowRunStarted(params: Readonly<{
    discussion: DiscussionAddressV1 | null;
    accountLifetime: ServerAccountScopeLifetime;
}>) {
    const { accountLifetime, discussion } = params;
    const windowId = discussion ? workflowRunListWindowStoreKey(discussionWorkflowRunListFilterId(discussion.discussionId), accountLifetime.scope) : null;
    return React.useCallback((result: WorkflowRunStartResultV1) => {
        if (!discussion || !windowId || !accountLifetime.isCurrent()) return;
        const origin = result.run.origin.kind === 'direct' ? result.run.origin.discussion : undefined;
        if (!origin || origin.discussion.discussionId !== discussion.discussionId
            || !areServerProfileIdentifiersEquivalent(origin.discussion.serverId, discussion.serverId)) return;
        getStorage().getState().applyWorkflowRunListPage({ scope: accountLifetime.scope, windowId,
            runs: [result.run], nextCursor: null, mode: 'append' });
    }, [accountLifetime, discussion?.discussionId, discussion?.serverId, windowId]);
}
