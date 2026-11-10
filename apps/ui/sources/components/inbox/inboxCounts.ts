import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { InboxItem } from './inboxItems';
import { admittedInboxDiscussionOccurrences, inboxItemView, type InboxDiscussionSource } from './inboxItemProjection';

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
    executionRuns?: number;
    automationRuns: number;
    approvalsAndNotices: number;
    operations: number;
    friendRequests: number;
    discussions?: number;
    machines?: number;
}>;

export function countInboxItems(parts: InboxCountParts): number {
    return parts.sessions + parts.workflowRuns + (parts.executionRuns ?? 0) + parts.automationRuns + parts.approvalsAndNotices + parts.operations + parts.friendRequests + (parts.discussions ?? 0) + (parts.machines ?? 0);
}

/** Read is not disposition: a live request remains attention until its owning source removes it. */
function countsInboxItem(item: Pick<InboxItem, 'view' | 'read'>): boolean {
    return isInboxNeedsYouItem(item) || !item.read;
}

/** Consume the row producer's placement; attention does not imply a current request. */
export function isInboxNeedsYouItem(item: Pick<InboxItem, 'view'>): boolean {
    return item.view === 'needs_you';
}

export function countInboxDiscussionItems(source: InboxDiscussionSource | null): number {
    if (!source) return 0;
    let count = 0;
    for (const { discussion, message, type } of admittedInboxDiscussionOccurrences(source)) {
        if (countsInboxItem({ view: inboxItemView(type), read: discussion.lastReadSeq !== null && message.seq <= discussion.lastReadSeq })) count += 1;
    }
    return count;
}

/** The model facts the counts read; lengths only. */
export type InboxCountSource = Readonly<{
    items?: readonly InboxItem[];
    openApprovals: ArrayLike<unknown>;
    openUsageNotices: ArrayLike<unknown>;
    actionOperationEntries: ArrayLike<unknown>;
    machineDeletionEntries?: ArrayLike<unknown>;
    machineReachabilityEntries?: ArrayLike<unknown>;
    friendRequests: ArrayLike<unknown>;
    sessionPresentation: Readonly<{ sessionsNeedingAttention: ArrayLike<unknown>; readySessions: ArrayLike<unknown> }>;
    workflowAttention: Readonly<{ runIds: ArrayLike<unknown> }>;
    automationAttention: Readonly<{ runIds: ArrayLike<unknown> }>;
}>;

/** The "Needs you" view's share of the count. */
export function countInboxNeedsYou(model: InboxCountSource): number {
    if (model.items) {
        const workflowUpdates = new Set<unknown>(model.items.filter(item => item.source.kind === 'workflow_run' && !isInboxNeedsYouItem(item))
            .map(item => item.source.id));
        return countInboxItems({
        sessions: model.items.filter(item => item.producer === 'live' && item.source.kind !== 'approval'
            && item.source.kind !== 'workflow_run' && item.source.kind !== 'automation_run'
            && isInboxNeedsYouItem(item)).length,
        workflowRuns: Array.from(model.workflowAttention.runIds).filter(runId => !workflowUpdates.has(runId)).length,
        automationRuns: model.automationAttention.runIds.length - model.items.filter(item => item.source.kind === 'automation_run' && !isInboxNeedsYouItem(item)).length,
        approvalsAndNotices: model.openApprovals.length + model.items.filter(item => item.producer === 'notice' && isInboxNeedsYouItem(item)).length,
        operations: model.actionOperationEntries.length, friendRequests: 0,
        });
    }
    return countInboxItems({
        sessions: model.sessionPresentation.sessionsNeedingAttention.length,
        workflowRuns: model.workflowAttention.runIds.length,
        automationRuns: model.automationAttention.runIds.length,
        approvalsAndNotices: model.openApprovals.length + model.openUsageNotices.length,
        operations: model.actionOperationEntries.length,
        friendRequests: 0,
        machines: model.machineDeletionEntries?.length ?? 0,
    });
}

/** The "Updates" view's share of the count: finished sessions to read and friend requests. */
export function countInboxUpdates(model: InboxCountSource): number {
    // An open usage notice is one Updates line drawn by its own card, never a generic item (see buildInboxItems).
    if (model.items) return model.items.filter(item => item.view === 'updates' && !item.read).length
        + model.openUsageNotices.length + model.friendRequests.length + (model.machineReachabilityEntries?.length ?? 0);
    return countInboxItems({
        sessions: model.sessionPresentation.readySessions.length,
        workflowRuns: 0,
        automationRuns: 0,
        approvalsAndNotices: 0,
        operations: 0,
        friendRequests: model.friendRequests.length,
        machines: model.machineReachabilityEntries?.length ?? 0,
    });
}

export function countInboxMentions(model: Pick<InboxCountSource, 'items'>): number {
    return model.items?.filter(item => item.view === 'mentions' && !item.read).length ?? 0;
}

/** Everything in the Inbox: the number the rail badge shows. */
export function countInbox(model: InboxCountSource): number {
    return countInboxNeedsYou(model) + countInboxUpdates(model) + countInboxMentions(model);
}

/** Whether the "Needs you" view draws any row, counted or parked: its empty state waits for none. */
export function hasInboxNeedsYouRows(model: Pick<InboxModel, 'workGroups'> & InboxCountSource): boolean {
    if (model.items) return model.items.some(isInboxNeedsYouItem) || countInboxNeedsYou(model) > 0;
    return model.workGroups.length > 0 || countInboxNeedsYou(model) > 0;
}
