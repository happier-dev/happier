import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionListAttention } from '@/activity/attention/buildDiscussionListAttention';
import { resolveInboxItemAttentionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

/**
 * One row of the Conversations list in the Collaboration pane (Lane 05 canonical owner).
 *
 * Collaboration is about people: Agent conversations live only in the Agents tab (lab `collab` A3),
 * so this list holds the Conversations heading and its creation action, the conversations with
 * people, and the section's own state while there are none to show.
 *
 * The union stays exhaustive and closed: the renderer is a switch, never a
 * registry, and no member exists without a producer here.
 */
export type DiscussionActivityItem =
    | Readonly<{ kind: 'human_section' }>
    | Readonly<{ kind: 'human_discussion'; discussion: DiscussionOpenedSummaryV1 }>
    /** The first page is still being read: its rows are reserved, never a blank body. */
    | Readonly<{ kind: 'human_pending' }>
    | Readonly<{ kind: 'human_empty' }>
    /** A recency group in the Discussions column: what needs you first, then by last activity. */
    | Readonly<{ kind: 'recency_group'; group: DiscussionRecencyGroup }>;

/** C1-admitted requests lead the column; mention news retains its recency group. */
export type DiscussionRecencyGroup = 'needs_you' | 'today' | 'this_week' | 'earlier';

/** Stable per-item list identity. */
export function discussionActivityItemKey(item: DiscussionActivityItem): string {
    switch (item.kind) {
        case 'human_section':
        case 'human_pending':
        case 'human_empty':
            return `section:${item.kind}`;
        case 'human_discussion':
            return `discussion:${item.discussion.id}`;
        case 'recency_group':
            return `group:${item.group}`;
    }
}

/** An anchor narrows presentation only; access and lifetime remain Discussion-owned. */
export function selectDiscussionSummariesForAnchor(
    discussions: readonly DiscussionOpenedSummaryV1[],
    anchor?: Readonly<{ kind: 'session'; sessionId: string }>,
): readonly DiscussionOpenedSummaryV1[] {
    if (!anchor) return discussions;
    return discussions.filter((discussion) => discussion.anchor?.kind === 'session' && discussion.anchor.sessionId === anchor.sessionId);
}

/**
 * Compose the section without owning its source: summaries arrive already activity-ordered from the
 * discussion repository, so this projection preserves that order rather than imposing another.
 */
export function buildDiscussionActivityItems(input: Readonly<{
    discussions: readonly DiscussionOpenedSummaryV1[];
    anchor?: Readonly<{ kind: 'session'; sessionId: string }>;
    /** The list has never settled yet, so it reserves rows instead of stating "empty". */
    humanListPending: boolean;
}>): readonly DiscussionActivityItem[] {
    const items: DiscussionActivityItem[] = [{ kind: 'human_section' }];
    const discussions = selectDiscussionSummariesForAnchor(input.discussions, input.anchor);
    for (const discussion of discussions) {
        items.push({ kind: 'human_discussion', discussion });
    }
    if (discussions.length === 0) {
        items.push({ kind: input.humanListPending ? 'human_pending' : 'human_empty' });
    }
    return items;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** C1 decides request admission; Discussion owns the remaining activity order. */
export function resolveDiscussionRecencyGroup(
    discussion: DiscussionOpenedSummaryV1,
    now: Date,
    /** The list's attention projection (approval, private draft, mention), when it is loaded. */
    attention?: Pick<DiscussionListAttention, 'attentionType'>,
): DiscussionRecencyGroup {
    const attentionType = attention?.attentionType;
    if (attentionType && resolveInboxItemAttentionV1(attentionType).interrupt) return 'needs_you';
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const at = discussion.latestMessage.createdAt;
    if (at >= startOfToday) return 'today';
    if (at >= startOfToday - 6 * DAY_MS) return 'this_week';
    return 'earlier';
}

/**
 * The Discussions column (lab T2-A): the column's own header names the list, so items start with the
 * groups — Needs you, Today, This week, Earlier — each keeping the repository's activity order.
 */
export function buildDiscussionColumnItems(input: Readonly<{
    discussions: readonly DiscussionOpenedSummaryV1[];
    humanListPending: boolean;
    now: Date;
    attention?: ReadonlyMap<string, Pick<DiscussionListAttention, 'attentionType'>>;
}>): readonly DiscussionActivityItem[] {
    if (input.discussions.length === 0) return [{ kind: input.humanListPending ? 'human_pending' : 'human_empty' }];
    const groups: Record<DiscussionRecencyGroup, DiscussionOpenedSummaryV1[]> = { needs_you: [], today: [], this_week: [], earlier: [] };
    for (const discussion of input.discussions) groups[resolveDiscussionRecencyGroup(discussion, input.now, input.attention?.get(discussion.id))].push(discussion);
    const items: DiscussionActivityItem[] = [];
    for (const group of ['needs_you', 'today', 'this_week', 'earlier'] as const) {
        if (groups[group].length === 0) continue;
        items.push({ kind: 'recency_group', group });
        for (const discussion of groups[group]) items.push({ kind: 'human_discussion', discussion });
    }
    return items;
}
