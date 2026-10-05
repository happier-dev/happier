import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { comparePendingRequestsByAge, selectOldestPendingRequest } from '@happier-dev/session-core/pending';

/**
 * FIN's session↔PR link read projection (`sessionPullRequestLink`, FIN PLAN U10 / 08 §5A), as this
 * Inbox consumes it. The producer has not landed; the model passes an empty list until it does.
 */
export type InboxPullRequestLink = Readonly<{
    sessionId: string;
    serverId?: string | null;
    number: number;
    title?: string | null;
    url?: string | null;
    state: 'open' | 'merged' | 'closed';
}>;

export type InboxWorkItem =
    /** A session that needs the person (permission, question, failure, …); `foldedUnderRunId` for a step session. */
    | Readonly<{ kind: 'session'; key: string; entry: InboxSessionAttentionEntry; foldedUnderRunId: string | null }>
    /** A workflow run in 03's attention window (a hold, an approval, an interrupted run). */
    | Readonly<{ kind: 'workflow_run'; key: string; runId: string; row: WorkflowRunRow }>
    /** A worker whose machine went offline while its turn was in flight. */
    | Readonly<{ kind: 'stalled'; key: string; session: Session }>
    /** A session whose linked pull request is open, waiting for the person to land and settle it. */
    | Readonly<{ kind: 'landing'; key: string; session: Session; link: InboxPullRequestLink }>
    /** A session the person snoozed until `remindAt`; it stays in place, quietly. */
    | Readonly<{ kind: 'snoozed'; key: string; session: Session; remindAt: number }>;

export type InboxWorkGroupRoot =
    | Readonly<{ kind: 'lead'; sessionId: string; session: Session | null }>
    | Readonly<{ kind: 'run'; runId: string; row: WorkflowRunRow }>
    | Readonly<{ kind: 'other' }>;

export type InboxWorkGroup = Readonly<{
    key: string;
    root: InboxWorkGroupRoot;
    items: readonly InboxWorkItem[];
}>;

export type InboxWorkGroupsInput = Readonly<{
    /** Needs-you and failed session entries from the canonical classifier, in Activity priority order. */
    sessionEntries: readonly InboxSessionAttentionEntry[];
    /** 03's attention window, in server order. */
    workflowRuns: readonly WorkflowRunRow[];
    stalledSessions: readonly Session[];
    landings: readonly Readonly<{ session: Session; link: InboxPullRequestLink }>[];
    snoozed: readonly Readonly<{ session: Session; remindAt: number }>[];
    /** Store lookup used to walk `reportsTo`; an unknown id stops the walk. */
    resolveSession: (sessionId: string) => Session | null | undefined;
    /**
     * The server origin link of a step session (ORC §3.1 `originRunId`, awareness `origin.runId`).
     * Absent until U4's awareness projection lands; then a step request folds under its run.
     */
    resolveOriginRunId: (entry: InboxSessionAttentionEntry) => string | null;
}>;

const ITEM_RANK: Readonly<Record<InboxWorkItem['kind'], number>> = {
    session: 0,
    workflow_run: 0,
    stalled: 1,
    landing: 2,
    snoozed: 3,
};

function normalizeId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function hasReports(session: Session | null | undefined): boolean {
    return (session?.reports?.total ?? 0) > 0;
}

/**
 * The work root of a session: the top of its `reportsTo` chain, or the session itself when it leads
 * others, or null for a loose session. The walk visits each id once, so a transiently cyclic store
 * (an edge seen before its reparent landed) cannot loop, and an unreadable lead stops it there.
 */
export function resolveInboxWorkRoot(
    sessionId: string,
    resolveSession: InboxWorkGroupsInput['resolveSession'],
): string | null {
    const start = resolveSession(sessionId) ?? null;
    let parent = normalizeId(start?.reportsTo?.sessionId);
    if (!parent) return hasReports(start) ? sessionId : null;
    const visited = new Set<string>([sessionId]);
    let current = sessionId;
    while (parent && !visited.has(parent)) {
        visited.add(parent);
        current = parent;
        parent = normalizeId(resolveSession(current)?.reportsTo?.sessionId);
    }
    return current;
}

/**
 * The Inbox grouped by the work each item belongs to (ORC R-10, §3.8; lab `inbox-I1`).
 *
 * - A session under a lead, or a lead itself, groups under the lead's work root.
 * - A workflow run groups under the work root of its origin session, else under itself.
 * - A step session's request folds once under its run when 03's window lists that run, and is
 *   never also listed on its own (FIN 03 §6.4 "Grouping").
 * - Everything else is "Other sessions", always last.
 *
 * It decides no attention: every item arrives already classified by its owner.
 */
export function buildInboxWorkGroups(input: InboxWorkGroupsInput): readonly InboxWorkGroup[] {
    const groups = new Map<string, { root: InboxWorkGroupRoot; items: InboxWorkItem[] }>();
    const other: InboxWorkItem[] = [];
    const listedRunIds = new Set(input.workflowRuns.map((row) => row.id));
    const stepsByRunId = new Map<string, InboxWorkItem[]>();
    // One row per session: a session already listed for what it needs is not listed again as
    // stalled, landing or snoozed.
    const listedSessionIds = new Set<string>();

    const leadGroup = (rootSessionId: string) => {
        const key = `lead:${rootSessionId}`;
        let group = groups.get(key);
        if (!group) {
            group = { root: { kind: 'lead', sessionId: rootSessionId, session: input.resolveSession(rootSessionId) ?? null }, items: [] };
            groups.set(key, group);
        }
        return group.items;
    };
    const placeSession = (sessionId: string, item: InboxWorkItem) => {
        const root = resolveInboxWorkRoot(sessionId, input.resolveSession);
        (root ? leadGroup(root) : other).push(item);
    };

    for (const entry of input.sessionEntries) {
        listedSessionIds.add(entry.candidate.sessionId);
        const originRunId = normalizeId(input.resolveOriginRunId(entry));
        const key = `session:${entry.candidate.address?.serverId ?? entry.candidate.serverId ?? ''}:${entry.candidate.sessionId}`;
        if (originRunId && listedRunIds.has(originRunId)) {
            const steps = stepsByRunId.get(originRunId) ?? [];
            steps.push({ kind: 'session', key, entry, foldedUnderRunId: originRunId });
            stepsByRunId.set(originRunId, steps);
            continue;
        }
        placeSession(entry.candidate.sessionId, { kind: 'session', key, entry, foldedUnderRunId: null });
    }

    for (const row of input.workflowRuns) {
        const runItems: InboxWorkItem[] = [
            { kind: 'workflow_run', key: `run:${row.id}`, runId: row.id, row },
            ...(stepsByRunId.get(row.id) ?? []),
        ];
        const origin = row.summary?.origin;
        const originSessionId = normalizeId(origin?.kind === 'direct' ? origin.originSessionId : null);
        const root = originSessionId ? resolveInboxWorkRoot(originSessionId, input.resolveSession) : null;
        if (root) {
            leadGroup(root).push(...runItems);
            continue;
        }
        groups.set(`run:${row.id}`, { root: { kind: 'run', runId: row.id, row }, items: runItems });
    }

    const placeOnce = (session: Session, item: InboxWorkItem) => {
        if (listedSessionIds.has(session.id)) return;
        listedSessionIds.add(session.id);
        placeSession(session.id, item);
    };
    for (const session of input.stalledSessions) {
        placeOnce(session, { kind: 'stalled', key: `stalled:${session.id}`, session });
    }
    for (const landing of input.landings) {
        placeOnce(landing.session, { kind: 'landing', key: `landing:${landing.session.id}`, ...landing });
    }
    for (const snoozed of input.snoozed) {
        placeOnce(snoozed.session, { kind: 'snoozed', key: `snoozed:${snoozed.session.id}`, ...snoozed });
    }

    const ordered: InboxWorkGroup[] = [];
    for (const [key, group] of groups) {
        ordered.push({ key, root: group.root, items: sortByRank(group.items) });
    }
    if (other.length > 0) ordered.push({ key: 'other', root: { kind: 'other' }, items: sortByRank(other) });
    return ordered;
}

function sortByRank(items: InboxWorkItem[]): readonly InboxWorkItem[] {
    const ranked = items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (ITEM_RANK[a.item.kind] - ITEM_RANK[b.item.kind]) || (a.index - b.index))
        .map(({ item }) => item);
    // Sort only pending-session slots with the same classification and run parent.
    // Failures, workflow rows and the broader work-group order retain their positions.
    const slots = new Map<string, Array<{ index: number; item: InboxWorkItem; request: NonNullable<ReturnType<typeof selectOldestPendingRequest>> }>>();
    ranked.forEach((item, index) => {
        if (item.kind !== 'session') return;
        const request = selectOldestPendingRequest([...item.entry.pendingPermissions, ...item.entry.pendingUserActions]);
        if (!request) return;
        const classification = `${item.entry.candidate.attentionState}:${item.foldedUnderRunId ?? ''}`;
        const group = slots.get(classification) ?? [];
        group.push({ index, item, request });
        slots.set(classification, group);
    });
    for (const group of slots.values()) {
        const sorted = [...group].sort((a, b) => comparePendingRequestsByAge(a.request, b.request) || a.item.key.localeCompare(b.item.key));
        group.forEach(({ index }, position) => { ranked[index] = sorted[position]!.item; });
    }
    return ranked;
}
