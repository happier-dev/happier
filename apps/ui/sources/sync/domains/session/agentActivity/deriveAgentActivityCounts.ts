import { isInProgressAgentActivityStatus, type AgentActivityStatusV1 } from '@happier-dev/protocol';

import { collectAgentActivityGroupingIds } from './agentActivityGrouping';
import type { AgentActivityEntry } from './types';

/**
 * How much agent work this session has, and how much of it is live — the ONE answer every
 * count-shaped surface uses.
 *
 * Today two surfaces ask: the session header glyph (which renders only while something is live) and
 * the header's own "is there anything to show" gate. They must never disagree, so there is exactly
 * one derivation and it is pure and source-agnostic.
 *
 * **It is keyed by KIND, not only by status.** A workflow run and the agents inside it are not two
 * populations to add up: the run is the box, its agents are the work. Counting both is how one
 * session reports three agents as four units. Which entries are boxes is decided by
 * `collectAgentActivityGroupingIds` and by nothing else.
 *
 * **It reports a work state, never an attention claim.** What is in flight is a fact about the
 * work; whether a person is needed is owned by the permission surfaces, and a second claim from an
 * agent tally would be a duplicate that eventually disagrees with the first.
 */

/**
 * What a counted unit IS.
 *
 * Narrower than the entry vocabulary on purpose: everything that is one agent's work counts as a
 * `subagent` whichever way it was launched, because that is the noun the product already uses for
 * a session's roster. Only a run — a box that can contain others — is told apart, because only that
 * distinction changes the arithmetic.
 */
export type AgentActivityCountKind = 'subagent' | 'workflow';

/**
 * The minimum a unit of agent work must expose to be counted.
 *
 * Structural, so a richer entry is assignable with no adapter. `parentId` and `runId` are read for
 * two purposes — recognising a container, and attributing a member to the run that speaks for it —
 * and never for numeric rollup: nothing here sums a child's tokens, duration or completion.
 */
export type AgentActivityCountable = Readonly<{
    id: string;
    kind: AgentActivityCountKind;
    status: AgentActivityStatusV1;
    /** The unit this one belongs to, when it belongs to one. Grouping and layout only. */
    parentId?: string | null;
    /**
     * The run this entry IS (when it is a run) or BELONGS TO (when it is one of its agents).
     *
     * A locally derived agent carries the run it was launched under even when no headline named it
     * a parent, so this is what lets a run's own agents be attributed to it rather than counted a
     * second time beside it.
     */
    runId?: string | null;
}>;

export type AgentActivityCounts = Readonly<{
    /**
     * How much work is in flight.
     *
     * "In flight" is the protocol's own `isInProgressAgentActivityStatus` — queued, starting,
     * running, dependency-blocked, or stopped on a permission prompt. An agent waiting for an
     * approval has not finished and has not failed; it is open work, and dropping it here would
     * hide it from every count in the app.
     *
     * It counts WORK, not roster rows: a live run contributes its live members, floored at one — a
     * run in flight is never zero live work, which is what stops a badge reading `0` in the window
     * between two phases while the workflow is genuinely running — and its members are never tallied
     * again beside it.
     */
    live: number;
    /**
     * Every counted unit, boxes excluded.
     *
     * The gate for "does this session have agent work at all". A run with members in the list is a
     * box and is not counted, because its members already are; a run with no members in the list is
     * the only thing representing that work and IS counted.
     */
    total: number;
}>;

export const EMPTY_AGENT_ACTIVITY_COUNTS: AgentActivityCounts = Object.freeze({ live: 0, total: 0 });

/**
 * A merged entry, as the shared counter reads it.
 *
 * The only kind that is told apart is the run, for the arithmetic reason above.
 */
export function toAgentActivityCountable(entry: AgentActivityEntry): AgentActivityCountable {
    return {
        id: entry.id,
        kind: entry.kind === 'workflow_run' ? 'workflow' : 'subagent',
        status: entry.status,
        parentId: entry.parentId,
        runId: entry.runId,
    };
}

function normalizeId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/**
 * The live run this entry is described by, or `null` when it is its own smallest unit.
 *
 * Two links, because membership is stated two ways: the headline names a member's `parentId`, and a
 * locally derived agent that no headline reached is joined by the `runId` it was launched under.
 * Only LIVE runs attract members: an agent still working under a run that has already finished has
 * nothing left to speak for it, and folding it into a run no surface draws as live would silence it.
 */
function resolveDescribingRunId(
    entry: AgentActivityCountable,
    liveRunEntryIds: ReadonlySet<string>,
    liveRunEntryIdByRunId: ReadonlyMap<string, string>,
): string | null {
    if (entry.kind !== 'subagent') return null;
    const parentId = normalizeId(entry.parentId);
    if (parentId && liveRunEntryIds.has(parentId)) return parentId;
    const runId = normalizeId(entry.runId);
    if (runId) return liveRunEntryIdByRunId.get(runId) ?? null;
    return null;
}

export function deriveAgentActivityCounts(
    entries: readonly AgentActivityCountable[],
): AgentActivityCounts {
    if (entries.length === 0) return EMPTY_AGENT_ACTIVITY_COUNTS;

    // One owner for "is this a box", shared with the roster's own partition: a count that
    // disagreed with the list it points at is the failure a single count exists to prevent.
    const groupingIds = collectAgentActivityGroupingIds(entries);

    // 1. The live runs, which every other decision below is keyed on.
    const liveRuns: AgentActivityCountable[] = [];
    const liveRunEntryIds = new Set<string>();
    const liveRunEntryIdByRunId = new Map<string, string>();
    for (const entry of entries) {
        if (entry.kind !== 'workflow') continue;
        if (!isInProgressAgentActivityStatus(entry.status)) continue;
        liveRuns.push(entry);
        liveRunEntryIds.add(entry.id);
        const runId = normalizeId(entry.runId);
        // First writer wins, mirroring the merge's own rule: two entries claiming one run id would
        // otherwise let a member be attributed to whichever happened to be last.
        if (runId && !liveRunEntryIdByRunId.has(runId)) liveRunEntryIdByRunId.set(runId, entry.id);
    }

    // 2. Attribute live members to the live run that describes them.
    const liveMembersByRunEntryId = new Map<string, number>();
    if (liveRuns.length > 0) {
        for (const entry of entries) {
            if (!isInProgressAgentActivityStatus(entry.status)) continue;
            const runEntryId = resolveDescribingRunId(entry, liveRunEntryIds, liveRunEntryIdByRunId);
            if (runEntryId === null) continue;
            liveMembersByRunEntryId.set(runEntryId, (liveMembersByRunEntryId.get(runEntryId) ?? 0) + 1);
        }
    }

    let live = 0;
    for (const run of liveRuns) {
        // A run in flight is never zero live work. Without this floor the count reads `0` in the
        // window between two phases — every named member terminal, the run still going.
        live += Math.max(1, liveMembersByRunEntryId.get(run.id) ?? 0);
    }

    let total = 0;
    for (const entry of entries) {
        if (groupingIds.has(entry.id)) continue;
        total += 1;
        if (entry.kind === 'workflow') continue;
        if (!isInProgressAgentActivityStatus(entry.status)) continue;
        // A run's own agents are deliberately absent here: the run's live complement already counts
        // them, and adding them again is the double count this owner exists to prevent.
        if (resolveDescribingRunId(entry, liveRunEntryIds, liveRunEntryIdByRunId) !== null) continue;
        live += 1;
    }

    return { live, total };
}
