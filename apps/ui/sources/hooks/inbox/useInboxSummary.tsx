import * as React from 'react';

import { useActivityOverviewSummary } from '@/activity/source/useActivityOverview';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import { readOpenUsageNoticeArtifactHeader } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { useInboxActionOperationSummary } from '@/sync/domains/actionOperations/useActionOperations';
import { useFriendRequestCount } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { countInboxItems } from '@/components/inbox/inboxCounts';

import { useAutomationAttentionSource, useWorkflowAttentionSource, WorkflowAttentionSourceBoundary } from './useWorkflowAttentionSource';

export type InboxSummary = Readonly<{
    count: number;
    hasContent: boolean;
}>;

export function createOpenApprovalInboxCountSelector(): (state: StorageState) => number {
    let previousArtifacts: StorageState['artifacts'] | null = null;
    let previousIsDataReady = false;
    let previousAccountId: string | null | undefined;
    let previousCount = 0;

    return (state) => {
        if (state.artifacts === previousArtifacts && state.isDataReady === previousIsDataReady
            && state.profileScope?.accountId === previousAccountId) {
            return previousCount;
        }
        previousArtifacts = state.artifacts;
        previousIsDataReady = state.isDataReady;
        previousAccountId = state.profileScope?.accountId;
        previousCount = 0;
        if (!state.isDataReady) return previousCount;
        for (const artifact of Object.values(state.artifacts)) {
            if (isOpenApprovalInboxArtifact(artifact)
                || (artifact.draft !== true && readOpenUsageNoticeArtifactHeader(artifact, previousAccountId))) previousCount += 1;
        }
        return previousCount;
    };
}

const selectOpenApprovalInboxCount = createOpenApprovalInboxCountSelector();

export function useInboxSummary(): InboxSummary {
    const activity = useActivityOverviewSummary();
    const openApprovalCount = storage(selectOpenApprovalInboxCount);
    const friendsEnabled = useFriendsEnabled();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendRequestCount = useFriendRequestCount();
    const actionOperations = useInboxActionOperationSummary();
    // Workflow attention is 03's window membership; the Inbox folds a step session's request
    // under its run, so a run is counted once here and its step rows are presentation.
    const workflowAttention = useWorkflowAttentionSource();
    const automationAttention = useAutomationAttentionSource();
    const visibleFriendRequestCount = friendsEnabled && friendsIdentityReadiness.isReady
        ? friendRequestCount
        : 0;
    // The one Inbox count formula, fed from the always-mounted narrow projections; an open Inbox
    // feeds the same formula from its model, so the badge, popover and page agree.
    const count = countInboxItems({
        sessions: activity.inboxContentCount,
        workflowRuns: workflowAttention.runIds.length,
        automationRuns: automationAttention.runIds.length,
        approvalsAndNotices: openApprovalCount,
        operations: actionOperations.count,
        friendRequests: visibleFriendRequestCount,
    });

    return React.useMemo(() => ({ count, hasContent: count > 0 }), [count]);
}

const InboxSummaryContext = React.createContext<InboxSummary | null>(null);

function InboxSummaryContextProvider(props: Readonly<{ children: React.ReactNode }>) {
    const summary = useInboxSummary();
    return (
        <InboxSummaryContext.Provider value={summary}>
            {props.children}
        </InboxSummaryContext.Provider>
    );
}

/** The app shell's one Inbox summary owner; it also mounts the one workflow attention loader. */
export function InboxSummaryProvider(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <WorkflowAttentionSourceBoundary>
            <InboxSummaryContextProvider>{props.children}</InboxSummaryContextProvider>
        </WorkflowAttentionSourceBoundary>
    );
}

export function useSharedInboxSummary(): InboxSummary {
    const summary = React.useContext(InboxSummaryContext);
    if (!summary) throw new Error('useSharedInboxSummary must be rendered under InboxSummaryProvider');
    return summary;
}
