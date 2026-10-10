import type { InboxModel } from '@/hooks/inbox/useInboxModel';

/**
 * The one Inbox count. The rail badge, the popover's header and the page's two views all read it, so
 * they cannot disagree: the always-mounted summary feeds `countInboxItems` from its narrow
 * projections, and an open Inbox feeds it from its model.
 *
 * What counts is what asks for the person: a session the Inbox classifier admits, a run in the
 * attention window (by id, whether or not its row has loaded yet), an open approval or usage notice,
 * an operation, a friend request. Rows the list also draws but that ask for nothing now (snoozed,
 * stalled) are not counted anywhere.
 */
export type InboxCountParts = Readonly<{
    sessions: number;
    workflowRuns: number;
    automationRuns: number;
    approvalsAndNotices: number;
    operations: number;
    friendRequests: number;
}>;

export function countInboxItems(parts: InboxCountParts): number {
    return parts.sessions + parts.workflowRuns + parts.automationRuns + parts.approvalsAndNotices + parts.operations + parts.friendRequests;
}

/** The model facts the counts read; lengths only. */
export type InboxCountSource = Readonly<{
    openApprovals: ArrayLike<unknown>;
    openUsageNotices: ArrayLike<unknown>;
    actionOperationEntries: ArrayLike<unknown>;
    friendRequests: ArrayLike<unknown>;
    sessionPresentation: Readonly<{ sessionsNeedingAttention: ArrayLike<unknown>; readySessions: ArrayLike<unknown> }>;
    workflowAttention: Readonly<{ runIds: ArrayLike<unknown> }>;
    automationAttention: Readonly<{ runIds: ArrayLike<unknown> }>;
}>;

/** The "Needs you" view's share of the count. */
export function countInboxNeedsYou(model: InboxCountSource): number {
    return countInboxItems({
        sessions: model.sessionPresentation.sessionsNeedingAttention.length,
        workflowRuns: model.workflowAttention.runIds.length,
        automationRuns: model.automationAttention.runIds.length,
        approvalsAndNotices: model.openApprovals.length + model.openUsageNotices.length,
        operations: model.actionOperationEntries.length,
        friendRequests: 0,
    });
}

/** The "Updates" view's share of the count: finished sessions to read and friend requests. */
export function countInboxUpdates(model: InboxCountSource): number {
    return countInboxItems({
        sessions: model.sessionPresentation.readySessions.length,
        workflowRuns: 0,
        automationRuns: 0,
        approvalsAndNotices: 0,
        operations: 0,
        friendRequests: model.friendRequests.length,
    });
}

/** Everything in the Inbox: the number the rail badge shows. */
export function countInbox(model: InboxCountSource): number {
    return countInboxNeedsYou(model) + countInboxUpdates(model);
}

/** Whether the "Needs you" view draws any row, counted or parked: its empty state waits for none. */
export function hasInboxNeedsYouRows(model: Pick<InboxModel, 'workGroups'> & InboxCountSource): boolean {
    return model.workGroups.length > 0 || countInboxNeedsYou(model) > 0;
}
