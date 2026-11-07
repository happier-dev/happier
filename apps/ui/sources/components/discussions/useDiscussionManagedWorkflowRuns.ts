import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowRunIdV1Schema } from '@happier-dev/protocol/workflows/workflowIdsV1';
import * as React from 'react';
import { useContextManagedWorkflowRuns } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage, useWorkflowRunRows } from '@/sync/domains/state/storage';
import { discussionWorkflowRunWindowId } from '@/sync/store/domains/workflowRuns';
import { resolveDiscussionWorkflowAttribution } from './discussionTimelineProjection';

const NO_RUN_IDS: readonly string[] = Object.freeze([]);

/** Demand-mounted timeline data, including Runs that have not published their first reply yet. */
export function useDiscussionManagedWorkflowRuns(params: Readonly<{
    discussion: DiscussionAddressV1;
    accountLifetime: ServerAccountScopeLifetime;
    messages?: readonly (Pick<DiscussionOpenedMessageV1, 'id' | 'producerV1'> & Partial<Pick<DiscussionOpenedMessageV1, 'localId'>>)[];
    enabled?: boolean;
}>) {
    const { accountLifetime, discussion } = params;
    const windowId = discussionWorkflowRunWindowId(accountLifetime.scope, discussion.discussionId);
    const retainedIds = getStorage()(state => state.workflowRunListWindows[windowId]?.runIds ?? NO_RUN_IDS);
    const retainedRows = useWorkflowRunRows(retainedIds, accountLifetime.scope);
    // Protected attribution is already on loaded replies (including external-plugin replies). The
    // retained window also keeps an acknowledged start before its first reply; no Account scan.
    const runIdsKey = React.useMemo(() => {
        const messageIds = new Set(params.messages?.map(message => message.id));
        const ids = new Set<string>();
        for (const row of retainedRows) {
            const origin = row.summary?.origin.kind === 'direct' ? row.summary.origin.discussion : undefined;
            if (origin?.discussion.discussionId === discussion.discussionId
                && areServerProfileIdentifiersEquivalent(origin.discussion.serverId, discussion.serverId)
                && messageIds.has(origin.messageId)) ids.add(row.id);
        }
        for (const message of params.messages ?? []) {
            // Composer questions persist their Run id as the post's local id. Ordinary
            // post ids are only lookup hints; the timeline validates the returned origin.
            const candidate = WorkflowRunIdV1Schema.safeParse(message.localId);
            if (candidate.success) ids.add(candidate.data);
            const attribution = resolveDiscussionWorkflowAttribution(message);
            if (attribution) ids.add(attribution.runId);
        }
        return JSON.stringify([...ids].sort());
    }, [discussion.discussionId, discussion.serverId, params.messages, retainedRows]);
    const runIds = React.useMemo<readonly string[]>(() => JSON.parse(runIdsKey), [runIdsKey]);
    const state = useContextManagedWorkflowRuns({ resource: { kind: 'discussion', id: params.discussion.discussionId },
        serverId: params.discussion.serverId, accountLifetime: params.accountLifetime,
        runIds,
        enabled: params.enabled !== false && areServerProfileIdentifiersEquivalent(params.accountLifetime.scope.serverId, params.discussion.serverId) });
    const onStarted = useDiscussionWorkflowRunStarted(params);
    return { ...state, onStarted, pending: runIds.length > 0 && (state.phase === 'loading' || state.phase === 'failed') };
}

/** The thread and its mounted Start share one acknowledged-Run projection owner. */
export function useDiscussionWorkflowRunStarted(params: Readonly<{
    discussion: DiscussionAddressV1;
    accountLifetime: ServerAccountScopeLifetime;
}>) {
    const { accountLifetime, discussion } = params;
    const windowId = discussionWorkflowRunWindowId(accountLifetime.scope, discussion.discussionId);
    return React.useCallback((result: WorkflowRunStartResultV1) => {
        if (!accountLifetime.isCurrent()) return;
        const origin = result.run.origin.kind === 'direct' ? result.run.origin.discussion : undefined;
        if (!origin || origin.discussion.discussionId !== discussion.discussionId
            || !areServerProfileIdentifiersEquivalent(origin.discussion.serverId, discussion.serverId)) return;
        getStorage().getState().applyWorkflowRunListPage({ scope: accountLifetime.scope, windowId,
            runs: [result.run], nextCursor: null, mode: 'append' });
    }, [accountLifetime, discussion.discussionId, discussion.serverId, windowId]);
}
