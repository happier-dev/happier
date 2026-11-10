import * as React from 'react';
import { AccountNoticeInvestigationBoundary } from './AccountNoticeInvestigationProvider';

import { useActivityOverviewSummary } from '@/activity/source/useActivityOverview';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { useInboxActionOperationSummary } from '@/sync/domains/actionOperations/useActionOperations';
import { useFriendRequestCount } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { countInboxDiscussionItems, countInboxItems, countInboxNeedsYou } from '@/components/inbox/inboxCounts';
import { useInboxDiscussionAttention } from './useInboxDiscussionSource';
import { InboxExecutionRunSourceBoundary, useInboxExecutionRunCount } from './useInboxExecutionRunSource';
import { InboxArtifactSourceBoundary, useInboxArtifactSource, useInboxArtifactOpenCount } from './useInboxArtifactSource';

import { useAutomationAttentionSource, useWorkflowAttentionSource, WorkflowAttentionSourceBoundary } from './useWorkflowAttentionSource';
import { useManagedMachineDeletionAttention } from '@/activity/source/useManagedMachineDeletionSource';
import { useInboxMachineReachability } from './useInboxMachineReachability';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

export type InboxSummary = Readonly<{
    count: number | null;
    /** The "Needs you" share of `count` (`countInboxNeedsYou`): what the rail counts in amber. */
    needsYouCount: number | null;
    hasContent: boolean | null;
}>;

const NO_ROWS: ArrayLike<unknown> = Object.freeze({ length: 0 });
const UNKNOWN_SUMMARY: InboxSummary = Object.freeze({ count: null, needsYouCount: null, hasContent: null });

export function useInboxSummary(): InboxSummary {
    const activity = useActivityOverviewSummary();
    const artifactSource = useInboxArtifactSource();
    const serverId = storage(state => state.profileScope?.serverId ?? null);
    const machineDeletionEntries = useManagedMachineDeletionAttention(serverId);
    const machineReachabilityEntries = useInboxMachineReachability(captureActiveServerAccountScopeLifetime());
    const openApprovalCount = useInboxArtifactOpenCount();
    const friendsEnabled = useFriendsEnabled();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendRequestCount = useFriendRequestCount();
    const actionOperations = useInboxActionOperationSummary();
    // Workflow attention is 03's window membership; the Inbox folds a step session's request
    // under its run, so a run is counted once here and its step rows are presentation.
    const workflowAttention = useWorkflowAttentionSource();
    const executionRuns = useInboxExecutionRunCount();
    const automationAttention = useAutomationAttentionSource();
    const discussionAttention = useInboxDiscussionAttention(serverId);
    const discussionCount = React.useMemo(() => countInboxDiscussionItems(discussionAttention.source), [discussionAttention.source]);
    const visibleFriendRequestCount = friendsEnabled && friendsIdentityReadiness.isReady
        ? friendRequestCount
        : 0;
    // The one Inbox count formula, fed from the always-mounted narrow projections; an open Inbox
    // feeds the same formula from its model, so the badge, popover and page agree.
    const count = countInboxItems({
        sessions: activity.inboxContentCount,
        workflowRuns: workflowAttention.runIds.length,
        executionRuns,
        automationRuns: automationAttention.runIds.length,
        approvalsAndNotices: openApprovalCount,
        operations: actionOperations.count,
        friendRequests: visibleFriendRequestCount,
        discussions: discussionCount,
        machines: machineDeletionEntries.length + machineReachabilityEntries.length,
    });

    // The same "Needs you" formula the open Inbox uses, fed lengths from the narrow projections.
    const needsYouCount = countInboxNeedsYou({
        sessionPresentation: { sessionsNeedingAttention: { length: activity.inboxNeedsYouCount }, readySessions: NO_ROWS },
        workflowAttention, automationAttention,
        openApprovals: { length: openApprovalCount }, openUsageNotices: NO_ROWS,
        actionOperationEntries: { length: actionOperations.count },
        machineDeletionEntries, friendRequests: NO_ROWS,
    });

    return React.useMemo(() => artifactSource.phase === 'current' ? { count, needsYouCount, hasContent: count > 0 }
        : UNKNOWN_SUMMARY, [count, needsYouCount, artifactSource.phase]);
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
        <AccountNoticeInvestigationBoundary><InboxArtifactSourceBoundary><WorkflowAttentionSourceBoundary>
            <InboxExecutionRunSourceBoundary><InboxSummaryContextProvider>{props.children}</InboxSummaryContextProvider></InboxExecutionRunSourceBoundary>
        </WorkflowAttentionSourceBoundary></InboxArtifactSourceBoundary></AccountNoticeInvestigationBoundary>
    );
}

export function useSharedInboxSummary(): InboxSummary {
    const summary = React.useContext(InboxSummaryContext);
    if (!summary) throw new Error('useSharedInboxSummary must be rendered under InboxSummaryProvider');
    return summary;
}
