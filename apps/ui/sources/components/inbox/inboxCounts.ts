import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { InboxItem } from './inboxItems';
import { admittedInboxDiscussionOccurrences, inboxItemView, type InboxDiscussionSource } from './inboxItemProjection';

/**
 * The one Inbox count. The rail badge, the popover's header and the page's two views all read it, so
 * they cannot disagree: the always-mounted summary feeds `countInboxItems` from its narrow
 * projections, and an open Inbox feeds it from its model.
 *
 * What counts is what asks for the person: a session the Inbox classifier admits, a run in the
 * attention window (by id before detail demand, by admitted row while open), an open approval or usage notice,
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
    /** One entry per work item (repeated failures fold into one, `selectInbox`). */
    actionOperationEntries: ArrayLike<Readonly<{ reason?: string }>>;
    machineDeletionEntries?: ArrayLike<unknown>;
    machineReachabilityEntries?: ArrayLike<unknown>;
    friendRequests: ArrayLike<unknown>;
    sessionPresentation: Readonly<{ sessionsNeedingAttention: ArrayLike<unknown>; readySessions: ArrayLike<unknown> }>;
    workflowAttention: Readonly<{ runIds: ArrayLike<unknown> }>;
    automationAttention: Readonly<{ runIds: ArrayLike<unknown> }>;
}>;

export type InboxNeedsYouKinds = Readonly<{
    approvals: number; decisions: number; blocked: number; failedActions: number; actions: number;
}>;

/**
 * What the open "Needs you" view counts, by kind: the page's summary names these, and their sum is the tab's
 * count. An approval Artifact counts once through `openApprovals`; every other row by its item type; an
 * operation entry (one per work item) as a failed action or one to check.
 */
export function countInboxNeedsYouByKind(model: InboxCountSource & Readonly<{ items: readonly InboxItem[] }>): InboxNeedsYouKinds {
    let approvals = model.openApprovals.length;
    let decisions = 0;
    let blocked = 0;
    for (const item of model.items) {
        if (item.source.kind === 'approval' || !isInboxNeedsYouItem(item)) continue;
        if (item.type === 'approval') approvals += 1;
        else if (item.type === 'decision') decisions += 1;
        else blocked += 1;
    }
    let failedActions = 0;
    for (const entry of Array.from(model.actionOperationEntries)) if (entry?.reason === 'failed') failedActions += 1;
    return { approvals, decisions, blocked, failedActions, actions: model.actionOperationEntries.length - failedActions };
}

/** The "Needs you" view's share of the count. */
export function countInboxNeedsYou(model: InboxCountSource): number {
    if (model.items) {
        const kinds = countInboxNeedsYouByKind({ ...model, items: model.items });
        return kinds.approvals + kinds.decisions + kinds.blocked + kinds.failedActions + kinds.actions;
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
