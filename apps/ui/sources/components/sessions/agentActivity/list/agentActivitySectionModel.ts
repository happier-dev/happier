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

export const AGENT_ACTIVITY_SECTION_IDS = ['working', 'finished'] as const;

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
 * **Two sections, and neither is an attention claim (4.7, r4.0).** The roster answers *what is this
 * session working on*; it does not answer *do you need to act*, which the pending-request card and
 * the session status already own.
 *
 * `waiting` — an agent stopped on a permission prompt — is still work in flight, so it sits under
 * WORKING with the same non-escalated treatment as `blocked`. It keeps its own glyph and status
 * word, which is where a reader sees it; giving it a section of its own made the header a demand.
 *
 * **`failed` is terminal, so it sits with the terminal rows.** It is not a call for a person: the
 * main agent handles a failed subagent, and there is no button here and no decision to make. The
 * row is fully visible where it lands — danger ink, `x-circle`, the word — and that visibility is
 * the point.
 *
 * `unknown` sits with the finished rows because it is the one thing it certainly is not: work we
 * can still claim is happening. Completion is evidence-based (4.9.3), and so is liveness — an
 * ambiguous entry must not occupy `working` and inflate what the reader believes is running.
 */
export function resolveAgentActivitySectionId(status: AgentActivityStatusV1): AgentActivitySectionId {
    switch (status) {
        case 'waiting':
        case 'queued':
        case 'starting':
        case 'running':
        case 'blocked':
            return 'working';
        case 'succeeded':
        case 'failed':
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

type RankedEntry = Readonly<{
    entry: AgentActivityRowEntry;
    /** Input position, the final tiebreak. Makes the order a total order, not an engine detail. */
    index: number;
}>;

function startedAt(entry: AgentActivityRowEntry): number {
    // An unknown start cannot claim to be the longest wait, so it sorts last rather than first.
    return entry.startedAtMs ?? Number.POSITIVE_INFINITY;
}

/**
 * When this entry last did something, for ordering the terminal rows.
 *
 * A terminal instant is the truth when we have one. When we do not, the most recent EVIDENCE about
 * the entry is the next best answer and it is a real one: a headline-only entry carries no
 * `endedAtMs` by design — inventing one from a progress instant is D-8 — so a workflow run that
 * failed a second ago would otherwise sort below every success from an hour ago, which is the
 * opposite of what this section is sorted by. Start time is the last resort, and an entry with none
 * of the three sinks rather than claiming to be the newest thing that happened.
 */
function endedAt(entry: AgentActivityRowEntry): number {
    return entry.endedAtMs ?? entry.updatedAtMs ?? entry.startedAtMs ?? Number.NEGATIVE_INFINITY;
}

/**
 * Oldest first.
 *
 * Start time ONLY. Ranking by status would walk a row upwards as it moved queued -> starting ->
 * running, reshuffling the section under a reader for no information they did not already get from
 * the row's own glyph — and floating a `waiting` row to the top would be the deleted attention
 * claim re-entering through the sort.
 */
function byOldestFirst(left: RankedEntry, right: RankedEntry): number {
    return startedAt(left.entry) - startedAt(right.entry) || left.index - right.index;
}

const COMPARE_BY_SECTION: Record<
    AgentActivitySectionId,
    (left: RankedEntry, right: RankedEntry) => number
> = {
    working: byOldestFirst,
    // Newest outcome first: this section answers "what just happened", and the cap below has to
    // keep the rows the reader is actually waiting on. Recency ONLY — a tier that floated failures
    // above the successes would be a lie about what the section is sorted by, and it would smuggle
    // back the attention claim this design removed.
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
     * Cap for the `working` section, or `null`/omitted for no cap.
     *
     * The compact surface is bounded — it spends most of a 520pt popover on the goal block and the
     * task list — so it shows the oldest few and expands in place. It is the same mechanism as the
     * finished cap rather than a private slice at the host, because a cap applied before ordering
     * keeps an arbitrary six rows rather than the six that have been running longest.
     */
    workingLimit?: number | null;
    /**
     * Where an entry is DRAWN, when that differs from where its status says it belongs.
     *
     * The migration choreography owns this: a finished agent stays in `working` for its dwell so
     * the reader keeps their place, and it is the placement — never the status — that lags. The
     * row still shows the mark it earned the instant it earned it, and the section count agrees
     * with the rows under it, so nothing on screen is telling a different story.
     */
    placementById?: ReadonlyMap<string, AgentActivitySectionId> | null;
    /**
     * Live units the HOST is already showing somewhere other than as rows in this list.
     *
     * A host that draws a running workflow as its own panel takes that run's members out of
     * `entries`, so the rows under WORKING are fewer than the live work the session actually has —
     * and the tab badge, the composer chip, the header glyph and the session-list row all state
     * that larger number from the one count owner. Left unstated, the reader is handed two numbers
     * about one thing and the arithmetic between them. The header therefore reports the section's
     * POPULATION rather than its row count, exactly as the FINISHED cap already does.
     *
     * It only applies to WORKING: a terminal run is never drawn as a panel, so nothing is folded
     * out of FINISHED. It also never CREATES the section — a heading over no rows, counting work
     * that is drawn above it, would read as rows that failed to render.
     */
    foldedWorkingCount?: number | null;
}>): AgentActivitySectionModel {
    const foldedWorkingCount = Math.max(0, Math.trunc(params.foldedWorkingCount ?? 0));
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
        const limit = id === 'finished' ? params.finishedLimit : params.workingLimit;
        const entries = typeof limit === 'number' && limit >= 0 && ordered.length > limit
            ? ordered.slice(0, limit)
            : ordered;

        // Rows the host folded into its own panels are part of WORKING's population, never part of
        // what this list hid: `hiddenCount` drives the "show all" affordance, and nothing here can
        // reveal a row that is already on screen inside a panel.
        const folded = id === 'working' ? foldedWorkingCount : 0;

        sections.push({
            id,
            entries,
            totalCount: ordered.length + folded,
            hiddenCount: ordered.length - entries.length,
        });
    }

    return { sections, totalCount: params.entries.length + foldedWorkingCount };
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
    | Readonly<{
        kind: 'showAll';
        key: string;
        /** Which cap this affordance lifts — the two sections word it differently. */
        sectionId: AgentActivitySectionId;
        totalCount: number;
        hiddenCount: number;
    }>;

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
                sectionId: section.id,
                totalCount: section.totalCount,
                hiddenCount: section.hiddenCount,
            });
        }
    }
    return items;
}
