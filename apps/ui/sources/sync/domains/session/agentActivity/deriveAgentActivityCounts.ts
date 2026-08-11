import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

import { collectAgentActivityGroupingIds } from './agentActivityGrouping';

/**
 * How many agents are doing what, in this session, right now — the ONE answer every count-shaped
 * surface uses.
 *
 * Four surfaces ask this question: the composer's work-state chip, the work-state popover, the
 * session header glyph and the Agents tab badge (plus the session-list row, off the projected
 * metadata). They must never disagree, so there is exactly one derivation and it is pure and
 * source-agnostic.
 *
 * **It reports a work state, never an attention claim.** The facts here are what is in flight and
 * what failed, and neither of them says a person is needed. Permission is owned by the
 * pending-request card and the session status; a second claim from an agent tally would be a
 * duplicate that eventually disagrees with the first.
 *
 * **It also owns the WORDS, not only the numbers (RULING-10).** How live work is described —
 * workflows and their agent complement, plain subagents, headless commands — is decided here rather
 * than in a label composer, because the previous split let a composer key its noun on whether member
 * agents happened to be locally derivable. That is a property of the reader, not of the work: the
 * noun flipped mid-run, and the fix that hid the flip understated a five-agent workflow as "1 agent
 * working". The run is the stable unit, described as its producer describes it.
 */

/**
 * What a counted unit IS, in the words a surface is allowed to speak.
 *
 * `backgroundTask` is spelled out rather than `task` because the composer row it feeds already
 * contains two other meanings of that word — a work-state plan item, and the chip icon kind for
 * one. A background command is neither: it is a headless process.
 */
export type AgentActivityCountKind = 'subagent' | 'workflow' | 'backgroundTask';

/**
 * The minimum a unit of agent work must expose to be counted.
 *
 * Structural, so a richer entry is assignable with no adapter. `parentId` and `runId` are read for
 * two purposes — recognising a container, and attributing a member to the run that speaks for it —
 * and never for numeric rollup (N-USAGE).
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
     * The count-only headline links no agent to its run, but every locally derived entry carries the
     * run it was launched under, so this is what lets a run's own agents be attributed to it rather
     * than described a second time beside it.
     */
    runId?: string | null;
    /**
     * How many of this run's agents the PRODUCER says are still RUNNING — `totalAgents` minus
     * `completedAgents` on the count-only headline (RULING-11, computed at `fromWorkflowHeadline`).
     *
     * Absent means the producer stated no figure, which is the unified headline's honest answer: it
     * names its members instead of counting them, so they are read live from this list. A stated
     * `0` is the opposite of absent — it is the producer saying nothing is in flight right now.
     *
     * Read ONLY to describe the run, never as a container signal. Trusting a producer's claim of
     * members as proof of members is what made every count-only workflow report `live: 0` while it
     * was running; `agentActivityGrouping` owns the corrected containment rule and states why. The
     * two questions are genuinely different: how much of a workflow is moving, and whether anything
     * else in this list already speaks for it.
     */
    liveAgentComplement?: number | null;
    /** Terminal instant, epoch ms. Orders the roster's finished rows. */
    endedAtMs?: number | null;
}>;

export type AgentActivityCounts = Readonly<{
    /**
     * **How much work is in flight — the same magnitude the chip describes (RULING-12).**
     *
     * Work in flight is queued, starting, running, dependency-blocked or stopped on a permission
     * prompt. An agent waiting for an approval has not finished and has not failed; it is the
     * reader's open work, and dropping it here would hide it from every count in the app.
     *
     * It counts AGENTS, not roster rows, and that is the fix. It used to count units — one per
     * entry the roster would draw — so a run counted as one whatever its producer said was moving
     * inside it, and the same session read "1 workflow, 2 agents" on the chip and `1` in the badge
     * an inch away. Three shapes disagreed: a count-only run understated (2 vs 1), the same run
     * with locally derived members OVERstated by counting those members on top of the complement
     * that already described them (2 vs 3), and a run whose named members had all gone terminal
     * printed a badge reading **0** while the workflow was genuinely running.
     *
     * So it is exactly `liveWorkflowAgents` (floored at one per running run — a run in flight is
     * never zero live work) plus `liveSubagents` plus `liveBackgroundTasks`: the three populations
     * the chip names, added once each. Nothing is counted twice, because a run's own agents are
     * attributed to it and never tallied again beside it.
     */
    live: number;
    /**
     * Work that failed.
     *
     * A separate number because it is a different fact, not because it is a louder one. Nothing
     * escalates from it: a failed subagent is handled by the main agent, so its roster row carries
     * it in full — danger ink, glyph, the word — and no chrome anywhere fills because of it.
     */
    failed: number;
    /** Every counted unit, groupings excluded. */
    total: number;
    /**
     * Live workflow runs, described as runs.
     *
     * A run is counted here whether or not any of its agents is in this list, which is the whole
     * point: the run is the stable unit, so the noun a surface speaks is keyed on the producer's
     * description of the work and not on how much of it this client happened to derive.
     */
    liveWorkflowRuns: number;
    /**
     * The LIVE agent complement of those runs, as their producer describes it (RULING-11).
     *
     * How much of the workflows is still moving — the goal is to state what IS currently running,
     * and a figure that included agents which finished ten minutes ago said "5 agents" about work
     * that was two. What must not move mid-run is the NOUN (RULING-10), and it does not: the run is
     * described as a run whether or not this client has derived a single member. **Not** a rollup:
     * nothing here sums a child's tokens, duration or completion, and no fraction is derived from
     * it (N-USAGE) — a producer's own two fields are subtracted at the source, and named members
     * are counted, never summed over.
     *
     * It is the figure the chip PRINTS, so it is stated exactly as the producer states it: a run
     * with nothing in flight contributes zero and the chip says "1 workflow running" rather than
     * inventing an agent. `live` is where that run is floored to one, because the reader still has
     * to be told something is running.
     */
    liveWorkflowAgents: number;
    /** Live agent units that belong to no live run, and are therefore their own smallest unit. */
    liveSubagents: number;
    /** Live headless background commands. Never an "agent" — a shell loop is not a colleague. */
    liveBackgroundTasks: number;
}>;

export const EMPTY_AGENT_ACTIVITY_COUNTS: AgentActivityCounts = Object.freeze({
    live: 0,
    failed: 0,
    total: 0,
    liveWorkflowRuns: 0,
    liveWorkflowAgents: 0,
    liveSubagents: 0,
    liveBackgroundTasks: 0,
});

/**
 * Which tally a status lands in.
 *
 * Exhaustive by construction: everything unfinished is live — `waiting` included, matching the
 * protocol's own `isInProgressAgentActivityStatus` — `failed` is its own fact, and every other
 * terminal state, `succeeded` included, is counted in `total` and nowhere else. That last part is
 * the composer's "never announce success" rule expressed as arithmetic rather than as a branch
 * someone can forget.
 */
function resolveCountBucket(status: AgentActivityStatusV1): 'live' | 'failed' | null {
    switch (status) {
        case 'failed':
            return 'failed';
        case 'queued':
        case 'starting':
        case 'running':
        case 'blocked':
        case 'waiting':
            return 'live';
        case 'succeeded':
        case 'timedOut':
        case 'cancelled':
        case 'unknown':
            return null;
        default: {
            const exhaustive: never = status;
            return exhaustive;
        }
    }
}

function normalizeId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/**
 * The live run this entry is described by, or `null` when it is its own smallest unit.
 *
 * Two links, because the two headlines describe membership differently: the unified one names a
 * member's `parentId`, and the count-only one names nobody at all — so a locally derived agent is
 * joined by the `runId` it was launched under. Only LIVE runs attract members: an agent still
 * working under a run that has already finished has nothing left to speak for it, and folding it
 * into a run no surface will draw as live would silence it.
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

    // One owner for "is this a container", shared with the roster's own selector: a count that
    // disagreed with the list it points at is the failure a single count exists to prevent. A run
    // whose members are not in this list is NOT a container — see `agentActivityGrouping`.
    const groupingIds = collectAgentActivityGroupingIds(entries);

    // 1. The live runs, which are what every other decision below is keyed on.
    const liveRuns: AgentActivityCountable[] = [];
    const liveRunEntryIds = new Set<string>();
    const liveRunEntryIdByRunId = new Map<string, string>();
    for (const entry of entries) {
        if (entry.kind !== 'workflow') continue;
        if (resolveCountBucket(entry.status) !== 'live') continue;
        liveRuns.push(entry);
        liveRunEntryIds.add(entry.id);
        const runId = normalizeId(entry.runId);
        // First writer wins, mirroring the merge's own rule: two entries claiming one run id would
        // otherwise let a member be attributed to whichever happened to be last.
        if (runId && !liveRunEntryIdByRunId.has(runId)) liveRunEntryIdByRunId.set(runId, entry.id);
    }

    // 2. Attribute LIVE members to the live run that describes them (RULING-11). Terminal ones are
    //    attributed too — that is what keeps them out of `liveSubagents`, since a finished agent of
    //    a running run is not a loose subagent — but only the live ones are its complement: the
    //    figure states what is running, not the roster the run started with.
    const liveNamedMembersByRunEntryId = new Map<string, number>();
    if (liveRuns.length > 0) {
        for (const entry of entries) {
            if (resolveCountBucket(entry.status) !== 'live') continue;
            const runEntryId = resolveDescribingRunId(entry, liveRunEntryIds, liveRunEntryIdByRunId);
            if (runEntryId === null) continue;
            liveNamedMembersByRunEntryId.set(runEntryId, (liveNamedMembersByRunEntryId.get(runEntryId) ?? 0) + 1);
        }
    }

    let liveWorkflowAgents = 0;
    // The same runs, floored — the tally's half of RULING-12. Kept as a second accumulator rather
    // than flooring `liveWorkflowAgents` itself, because the two answer different questions: the
    // chip PRINTS the producer's figure (and says "1 workflow running" when it is zero, rather than
    // inventing an agent nobody claimed), while the tally has to say that something is running.
    let liveWorkflowMagnitude = 0;
    for (const run of liveRuns) {
        // The producer's own statement first; the live members it named otherwise. Both are the
        // producer describing its run — the count-only headline states a number because it cannot
        // state names, and the unified headline states names because it does not carry a number.
        //
        // `null` and `0` are different answers, and conflating them is how the retired figure comes
        // back: absent means "I count nothing, read my members", while a stated zero means "nothing
        // of mine is in flight" and must survive as zero.
        const stated = typeof run.liveAgentComplement === 'number' && Number.isFinite(run.liveAgentComplement)
            ? Math.max(0, Math.trunc(run.liveAgentComplement))
            : null;
        const complement = stated ?? (liveNamedMembersByRunEntryId.get(run.id) ?? 0);
        liveWorkflowAgents += complement;
        // A run in flight is never zero live work. Without this floor the badge reads 0 during the
        // window between two phases — every named member terminal, the run still going — which is
        // the same "invisible while running" defect FIX-1 fixed one layer up, on the chip.
        liveWorkflowMagnitude += Math.max(1, complement);
    }

    let failed = 0;
    let total = 0;
    let liveSubagents = 0;
    let liveBackgroundTasks = 0;

    for (const entry of entries) {
        if (groupingIds.has(entry.id)) continue;
        total += 1;
        const bucket = resolveCountBucket(entry.status);
        if (bucket === 'live') {
            if (entry.kind === 'backgroundTask') liveBackgroundTasks += 1;
            else if (
                entry.kind === 'subagent'
                && resolveDescribingRunId(entry, liveRunEntryIds, liveRunEntryIdByRunId) === null
            ) {
                liveSubagents += 1;
            }
            // A run's own agents are deliberately absent from every tally here: the run's
            // complement already counts them, and adding them again is the double count that made
            // one session say "2 agents" on the chip and `3` on the badge beside it.
            continue;
        }
        if (bucket === 'failed') failed += 1;
    }

    return {
        // RULING-12: the tally counts the same thing the chip describes — the three populations the
        // chip names, added once each. Runs are counted here even when they are containers, which
        // the loop above skips: a running workflow is live work whether or not its members happen
        // to be in this list.
        live: liveWorkflowMagnitude + liveSubagents + liveBackgroundTasks,
        failed,
        total,
        liveWorkflowRuns: liveRuns.length,
        liveWorkflowAgents,
        liveSubagents,
        liveBackgroundTasks,
    };
}

/**
 * Is this session working on something — the ONE answer, for every gate that asks (FIX-F1).
 *
 * Two gates used to decide it independently: the composer chip asked whether it had a sentence to
 * render, and the popover-retention effect asked whether the unit tally was non-zero. On a run
 * whose named members have all gone terminal those answers differ — the run is a container, so
 * `live` is 0 while the workflow carries on — and the disagreement was user-visible in the worst
 * possible way: the chip stayed on screen naming the workflow while the effect cleared the open
 * badge key and force-closed the work-state popover the reader had open, at the exact moment the
 * last member finished.
 *
 * It is deliberately keyed on the POPULATIONS a surface can name rather than on `live`. Those are
 * the same three segments `formatSessionAgentActivityLabel` composes, so "the chip has something to
 * say" and "there is live work" are one fact by construction and cannot drift apart again. `live`
 * remains the unit tally — how many rows a roster draws — which is a different question with its
 * own readers (the header glyph, the Agents tab badge).
 */
export function hasLiveAgentActivity(counts: AgentActivityCounts): boolean {
    return counts.liveWorkflowRuns > 0 || counts.liveSubagents > 0 || counts.liveBackgroundTasks > 0;
}
