import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';

/**
 * How a roster of agent work is divided and ordered (4.7).
 *
 * Pure, and deliberately so: partitioning and ordering are the two decisions a reader feels most
 * directly — a row that moves while they are reading it costs them their place — and they are the
 * two that are cheapest to test exhaustively. Nothing here touches React, theme or translation.
 *
 * **One list, not three.** The sections are header rows inside a single sequence; a row that
 * finishes moves *within* that sequence rather than being unmounted from one container and
 * remounted in another. That is what lets the finishing agent visibly travel to `finished` instead
 * of blinking out and blinking back in somewhere else.
 */

export const AGENT_ACTIVITY_SECTION_IDS = ['needsYou', 'working', 'finished'] as const;

export type AgentActivitySectionId = (typeof AGENT_ACTIVITY_SECTION_IDS)[number];

/**
 * How many finished rows a docked pane shows before deferring to the full-screen route.
 *
 * The cap applies only when the host supplies somewhere for "show all" to go — see
 * `buildAgentActivitySectionModel`'s `finishedLimit`.
 */
export const AGENT_ACTIVITY_FINISHED_IN_PANE_LIMIT = 24;

export type AgentActivitySection = Readonly<{
    id: AgentActivitySectionId;
    /** Ordered, and capped for `finished` when the host asked for a cap. */
    entries: readonly AgentActivityRowEntry[];
    /** How many entries the section holds before any cap. */
    totalCount: number;
    /** `totalCount - entries.length`. Non-zero only when a cap hid something. */
    hiddenCount: number;
}>;

export type AgentActivitySectionModel = Readonly<{
    /** Only the non-empty sections, always in `AGENT_ACTIVITY_SECTION_IDS` order. */
    sections: readonly AgentActivitySection[];
    totalCount: number;
}>;

/**
 * Which section a status belongs to. Exhaustive by construction: a new protocol status fails to
 * compile here rather than falling into whichever branch happens to be last.
 *
 * `unknown` sits with the finished rows because it is the one thing it certainly is not: work we
 * can still claim is happening. Completion is evidence-based (4.9.3), and so is liveness — an
 * ambiguous entry must not occupy `working` and inflate what the reader believes is running.
 */
export function resolveAgentActivitySectionId(status: AgentActivityStatusV1): AgentActivitySectionId {
    switch (status) {
        case 'waiting':
        case 'failed':
            return 'needsYou';
        case 'queued':
        case 'starting':
        case 'running':
        case 'blocked':
            return 'working';
        case 'succeeded':
        case 'timedOut':
        case 'cancelled':
        case 'unknown':
            return 'finished';
        default: {
            const exhaustive: never = status;
            return exhaustive;
        }
    }
}

/**
 * Rank inside `NEEDS YOU`, the one section the plan asks to be priority-sorted.
 *
 * `waiting` first because it is the only status a person can clear right now; `failed` is already
 * over and needs reading, not unblocking.
 */
const NEEDS_YOU_RANK: Partial<Record<AgentActivityStatusV1, number>> = {
    waiting: 0,
    failed: 1,
};

type RankedEntry = Readonly<{
    entry: AgentActivityRowEntry;
    /** Input position, the final tiebreak. Makes the order a total order, not an engine detail. */
    index: number;
}>;

function startedAt(entry: AgentActivityRowEntry): number {
    // An unknown start cannot claim to be the longest wait, so it sorts last rather than first.
    return entry.startedAtMs ?? Number.POSITIVE_INFINITY;
}

function endedAt(entry: AgentActivityRowEntry): number {
    return entry.endedAtMs ?? entry.startedAtMs ?? Number.NEGATIVE_INFINITY;
}

const COMPARE_BY_SECTION: Record<
    AgentActivitySectionId,
    (left: RankedEntry, right: RankedEntry) => number
> = {
    // Priority first, then the longest wait: the person scanning this section is deciding who to
    // unblock, and "has been stuck longest" is the fact that decides it.
    needsYou: (left, right) => (
        (NEEDS_YOU_RANK[left.entry.status] ?? 0) - (NEEDS_YOU_RANK[right.entry.status] ?? 0)
        || startedAt(left.entry) - startedAt(right.entry)
        || left.index - right.index
    ),
    // Start time ONLY. Ranking by status here would walk a row upwards as it moved
    // queued -> starting -> running, reshuffling the section under a reader for no information
    // they did not already get from the row's own glyph.
    working: (left, right) => (
        startedAt(left.entry) - startedAt(right.entry)
        || left.index - right.index
    ),
    // Newest outcome first: this section answers "what just happened", and the cap below has to
    // keep the rows the reader is actually waiting on.
    finished: (left, right) => (
        endedAt(right.entry) - endedAt(left.entry)
        || left.index - right.index
    ),
};

export function buildAgentActivitySectionModel(params: Readonly<{
    entries: readonly AgentActivityRowEntry[];
    /**
     * Cap for the `finished` section, or `null`/omitted for no cap.
     *
     * A host passes a number only when it can route "show all" somewhere. Capping without that
     * route would leave rows that exist and cannot be reached.
     */
    finishedLimit?: number | null;
    /**
     * Where an entry is DRAWN, when that differs from where its status says it belongs.
     *
     * The migration choreography owns this: a finished agent stays in `working` for its dwell so
     * the reader keeps their place, and it is the placement — never the status — that lags. The
     * row still shows the mark it earned the instant it earned it, and the section count agrees
     * with the rows under it, so nothing on screen is telling a different story.
     */
    placementById?: ReadonlyMap<string, AgentActivitySectionId> | null;
}>): AgentActivitySectionModel {
    const buckets = new Map<AgentActivitySectionId, RankedEntry[]>();
    for (const id of AGENT_ACTIVITY_SECTION_IDS) buckets.set(id, []);

    params.entries.forEach((entry, index) => {
        const placement = params.placementById?.get(entry.id)
            ?? resolveAgentActivitySectionId(entry.status);
        buckets.get(placement)!.push({ entry, index });
    });

    const sections: AgentActivitySection[] = [];
    for (const id of AGENT_ACTIVITY_SECTION_IDS) {
        const ranked = buckets.get(id)!;
        if (ranked.length === 0) continue;

        ranked.sort(COMPARE_BY_SECTION[id]);
        const ordered = ranked.map((item) => item.entry);
        const limit = id === 'finished' ? params.finishedLimit : null;
        const entries = typeof limit === 'number' && limit >= 0 && ordered.length > limit
            ? ordered.slice(0, limit)
            : ordered;

        sections.push({
            id,
            entries,
            totalCount: ordered.length,
            hiddenCount: ordered.length - entries.length,
        });
    }

    return { sections, totalCount: params.entries.length };
}

/**
 * The rendered sequence: headers, rows and the one "show all" affordance, in order.
 *
 * The list maps this array exactly once, which is what keeps every row a sibling of every other
 * row and of every header. A per-section container would look identical and would break the
 * section migration, because a row changing section would change parent and remount.
 */
export type AgentActivityListItem =
    | Readonly<{ kind: 'header'; key: string; sectionId: AgentActivitySectionId; count: number }>
    | Readonly<{
        kind: 'row';
        key: string;
        entry: AgentActivityRowEntry;
        /** Last row of its section: the divider stops here so sections read as separate. */
        isLastInSection: boolean;
    }>
    | Readonly<{ kind: 'showAll'; key: string; totalCount: number; hiddenCount: number }>;

export function flattenAgentActivitySectionModel(
    model: AgentActivitySectionModel,
): readonly AgentActivityListItem[] {
    const items: AgentActivityListItem[] = [];
    for (const section of model.sections) {
        items.push({
            kind: 'header',
            key: `section:${section.id}`,
            sectionId: section.id,
            count: section.totalCount,
        });
        section.entries.forEach((entry, index) => {
            items.push({
                kind: 'row',
                key: entry.id,
                entry,
                isLastInSection: index === section.entries.length - 1,
            });
        });
        if (section.hiddenCount > 0) {
            items.push({
                kind: 'showAll',
                key: `show-all:${section.id}`,
                totalCount: section.totalCount,
                hiddenCount: section.hiddenCount,
            });
        }
    }
    return items;
}
