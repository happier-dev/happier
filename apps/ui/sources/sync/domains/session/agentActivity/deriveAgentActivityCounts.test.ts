import { describe, expect, it } from 'vitest';

import {
    EMPTY_AGENT_ACTIVITY_COUNTS,
    deriveAgentActivityCounts,
    hasLiveAgentActivity,
    type AgentActivityCountable,
} from './deriveAgentActivityCounts';

function countable(overrides: Partial<AgentActivityCountable> & Pick<AgentActivityCountable, 'id' | 'status'>): AgentActivityCountable {
    return { kind: 'subagent', ...overrides };
}

describe('deriveAgentActivityCounts', () => {
    it('returns the shared empty counts for no work at all', () => {
        expect(deriveAgentActivityCounts([])).toBe(EMPTY_AGENT_ACTIVITY_COUNTS);
    });

    /**
     * r4.0: there is no attention tally. A work state has two facts — what is in flight and what
     * failed — and `waiting` is in flight: an agent stopped on a permission prompt is still open
     * work the reader is waiting on. The protocol agrees (`isInProgressAgentActivityStatus`).
     *
     * This is also the guard against the deletion silently DROPPING a permission-blocked agent:
     * before r4.0 `waiting` was its own bucket, and removing that bucket without re-homing the
     * status would have made a blocked agent vanish from every open count in the app.
     */
    it('counts a permission-blocked agent as live work, not as an attention claim', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'a', status: 'queued' }),
            countable({ id: 'b', status: 'starting' }),
            countable({ id: 'c', status: 'running' }),
            countable({ id: 'd', status: 'blocked' }),
            countable({ id: 'e', status: 'waiting' }),
            countable({ id: 'f', status: 'failed' }),
        ]);

        expect(counts).toEqual({
            live: 5,
            failed: 1,
            total: 6,
            liveWorkflowRuns: 0,
            liveWorkflowAgents: 0,
            liveSubagents: 5,
            liveBackgroundTasks: 0,
        });
        expect(counts).not.toHaveProperty('needsYou');
    });

    /**
     * The composer must never announce a success, and the cheapest way to guarantee that is to give
     * it no number to announce. A succeeded agent still exists (`total`) so a surface that wants
     * history can find it, but no label can be reached by it.
     */
    it('counts a succeeded agent in the total and in no live tally', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'a', status: 'succeeded' }),
            countable({ id: 'b', status: 'cancelled' }),
            countable({ id: 'c', status: 'unknown' }),
            countable({ id: 'd', status: 'timedOut' }),
        ]);

        expect(counts).toMatchObject({ live: 0, failed: 0, total: 4 });
    });

    /**
     * Failure is carried as information — a number a roster row can be scanned for — and nothing
     * derives an instant, a retention window or an acknowledgement from it. `latestFailureAtMs` was
     * the last residue of that model and no consumer ever read it.
     */
    it('carries no failure instant for anything to retain', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'a', status: 'failed', endedAtMs: 1_000 }),
            countable({ id: 'b', status: 'failed', endedAtMs: 9_000 }),
        ]);

        expect(counts).toEqual({
            live: 0,
            failed: 2,
            total: 2,
            liveWorkflowRuns: 0,
            liveWorkflowAgents: 0,
            liveSubagents: 0,
            liveBackgroundTasks: 0,
        });
    });

    /**
     * The implicit `Agent activity` run is a `workflow_run` entry whose children are the subagents
     * it groups. Counting every entry reports three subagents as four agents; a naive
     * `entries.length` would pass a test that only ever fed a flat list.
     */
    it('does not count a grouping as a unit of work', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running' }),
            countable({ id: 'a', status: 'running', parentId: 'run' }),
            countable({ id: 'b', status: 'running', parentId: 'run' }),
            countable({ id: 'c', status: 'running', parentId: 'run' }),
        ]);

        expect(counts).toMatchObject({ live: 3, total: 3 });
    });

    it('still counts a childless workflow run as its own unit of work', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running' }),
        ]);

        expect(counts).toMatchObject({ live: 1, total: 1 });
    });

    /**
     * The other half of the same rule, and the one that shipped broken.
     *
     * The count-only workflow headline reports `totalAgents` and no names, so the run used to
     * declare itself a container on the producer's word alone. Nothing else in the list represented
     * that work, so a genuinely running workflow reported `live: 0` — the chip vanished, the header
     * glyph read 0, the tab badge read 0 and the session-list row read 0, while both rosters drew
     * the run as a live panel. A container whose members are absent has nothing to double count.
     */
    it('counts a run whose members the producer could not name', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running' }),
        ]);

        expect(counts).toMatchObject({ live: 1, total: 1 });
    });

    /**
     * ...and it must still not double count once the members ARE in the list. This is the pair the
     * rule has to satisfy at once: the same run, with and without named members.
     */
    it('does not count a run whose members the producer DID name', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running' }),
            countable({ id: 'a', status: 'running', parentId: 'run' }),
            countable({ id: 'b', status: 'running', parentId: 'run' }),
        ]);

        expect(counts).toMatchObject({ live: 2, total: 2 });
    });

    /**
     * A failed run that named no agent is still a fact the roster has to carry: it is the only row
     * that says the workflow failed at all.
     */
    it('counts a failed memberless run as failure, not as nothing', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'failed' }),
        ]);

        expect(counts).toMatchObject({ live: 0, failed: 1, total: 1 });
    });
});

/**
 * RULING-10: the run is the stable unit.
 *
 * These are the scalars a surface needs to say what is running without inventing a noun the model
 * cannot keep. Collapsing every kind into one figure understated a five-agent workflow to
 * "1 agent working"; keying the noun on whether members happened to be locally derivable made the
 * word flip mid-run. Both are answered here, at the one owner, rather than in a label composer.
 */
describe('deriveAgentActivityCounts — how live work is described', () => {
    it('describes a count-only run as a run PLUS the agent complement its producer states', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running', runId: 'wf1', liveAgentComplement: 5 }),
        ]);

        // RULING-12: the tally is the magnitude, not the row count. `live: 1` here is what let the
        // chip say "1 workflow, 5 agents" beside a badge reading `1`.
        expect(counts).toMatchObject({
            live: 5,
            liveWorkflowRuns: 1,
            liveWorkflowAgents: 5,
            liveSubagents: 0,
            liveBackgroundTasks: 0,
        });
    });

    /**
     * The flip, made structurally impossible.
     *
     * The same run, once its agents are derivable from the transcript. The count-only headline links
     * none of them, but every local entry carries the `runId` it was launched under, so they are
     * attributed to the run instead of counted a second time beside it. The description does not
     * move: one workflow, five agents, before and after.
     */
    it('attributes locally derived members to their run instead of describing them twice', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running', runId: 'wf1', liveAgentComplement: 5 }),
            countable({ id: 'a', status: 'running', runId: 'wf1' }),
            countable({ id: 'b', status: 'running', runId: 'wf1' }),
            countable({ id: 'c', status: 'running', runId: 'wf1' }),
        ]);

        expect(counts).toMatchObject({
            liveWorkflowRuns: 1,
            liveWorkflowAgents: 5,
            liveSubagents: 0,
        });
        // And the tally is the SAME magnitude (RULING-12). It read `4` here — the run as a unit
        // plus its three derived members — which is the double count: those members are three of
        // the five agents the complement already counts, so adding them on top described the same
        // agents twice. The rosters still draw the run beside them (see `agentActivityGrouping`);
        // what is drawn and what is counted are different questions.
        expect(counts.live).toBe(5);
    });

    /**
     * RULING-11: the unified headline names members instead of counting them, so the members ARE
     * the producer's statement — and the figure a surface speaks is the LIVE part of it. A
     * complement that included agents which finished ten minutes ago says five about work that is
     * two, which is the overstatement the goal "display what IS currently running" forbids.
     *
     * This is also the reviewer's worked example: 5 named agents, 3 done. `live` counts 2 units
     * here (the run is a container), so the description and the unit tally state one magnitude.
     */
    it('reads a named run’s LIVE complement off the members the producer named', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running', runId: 'wf1' }),
            countable({ id: 'a', status: 'running', parentId: 'run', runId: 'wf1' }),
            countable({ id: 'b', status: 'running', parentId: 'run', runId: 'wf1' }),
            countable({ id: 'c', status: 'succeeded', parentId: 'run', runId: 'wf1' }),
            countable({ id: 'd', status: 'succeeded', parentId: 'run', runId: 'wf1' }),
            countable({ id: 'e', status: 'succeeded', parentId: 'run', runId: 'wf1' }),
        ]);

        expect(counts).toMatchObject({
            live: 2,
            liveWorkflowRuns: 1,
            liveWorkflowAgents: 2,
            liveSubagents: 0,
        });
    });

    it('describes a run that states no agents as a run and nothing more', () => {
        expect(deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running', runId: 'wf1', liveAgentComplement: 0 }),
        ])).toMatchObject({ liveWorkflowRuns: 1, liveWorkflowAgents: 0 });
    });

    /**
     * A stated ZERO is a statement, not an absence.
     *
     * The producer field is now the run's live complement, so `0` means "everything I launched has
     * finished" — an honest state a running run passes through between phases. Reading it as "said
     * nothing" and falling back to the members this client happened to derive would put the roster
     * back in charge of a figure RULING-10/11 gave to the producer, and would resurrect the number
     * the producer just retired.
     */
    it('takes a producer’s stated zero literally instead of falling back to derived members', () => {
        expect(deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running', runId: 'wf1', liveAgentComplement: 0 }),
            countable({ id: 'a', status: 'running', runId: 'wf1' }),
            countable({ id: 'b', status: 'running', runId: 'wf1' }),
        ])).toMatchObject({ liveWorkflowRuns: 1, liveWorkflowAgents: 0 });
    });

    /**
     * Attribution follows LIVE runs only. A subagent still working under a run that has already
     * finished has nothing left to describe it, so it is its own unit again rather than folded into
     * a run no surface will draw as live.
     */
    it('describes a subagent whose run has finished as a plain subagent', () => {
        expect(deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'succeeded', runId: 'wf1' }),
            countable({ id: 'a', status: 'running', runId: 'wf1' }),
        ])).toMatchObject({ liveWorkflowRuns: 0, liveWorkflowAgents: 0, liveSubagents: 1 });
    });

    it('keeps runs, plain subagents and background commands as three separate facts', () => {
        expect(deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running', runId: 'wf1', liveAgentComplement: 5 }),
            countable({ id: 'a', status: 'running' }),
            countable({ id: 'b', status: 'running' }),
            countable({ id: 'bg', kind: 'backgroundTask', status: 'running' }),
            countable({ id: 'done', status: 'succeeded' }),
        ])).toMatchObject({
            liveWorkflowRuns: 1,
            liveWorkflowAgents: 5,
            liveSubagents: 2,
            liveBackgroundTasks: 1,
        });
    });

    /**
     * A running run whose named agents have ALL finished — the window between two phases.
     *
     * The tally used to report ZERO here: the run is a container, so every unit in the list was
     * terminal, and the badge printed `0` while a workflow was genuinely running — the same
     * "invisible while running" defect FIX-1 fixed on the chip, surviving one layer down. A run in
     * flight is never zero live work, so it floors at one (RULING-12).
     *
     * The agent FIGURE stays zero, and that is not the same claim: none of the run's agents is
     * running, so the chip says "1 workflow running" rather than inventing an agent nobody named
     * (RULING-11).
     */
    it('still counts a run whose named agents have all finished, with no agent figure', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'running', runId: 'wf1' }),
            countable({ id: 'a', status: 'succeeded', parentId: 'run', runId: 'wf1' }),
            countable({ id: 'b', status: 'succeeded', parentId: 'run', runId: 'wf1' }),
        ]);
        expect(counts).toMatchObject({ live: 1, liveWorkflowRuns: 1, liveWorkflowAgents: 0 });
        expect(hasLiveAgentActivity(counts)).toBe(true);
    });

    it('describes nothing when nothing is live', () => {
        const counts = deriveAgentActivityCounts([
            countable({ id: 'run', kind: 'workflow', status: 'failed', runId: 'wf1', liveAgentComplement: 5 }),
            countable({ id: 'a', status: 'succeeded' }),
        ]);
        expect(counts).toMatchObject({
            liveWorkflowRuns: 0,
            liveWorkflowAgents: 0,
            liveSubagents: 0,
            liveBackgroundTasks: 0,
        });
        expect(hasLiveAgentActivity(counts)).toBe(false);
    });
});

/**
 * FIX-F1: ONE answer to "is there live work".
 *
 * Two gates asked it independently — the chip asked whether a label existed, the popover-retention
 * effect asked whether the unit tally was non-zero — and on a run between phases they disagreed:
 * the chip stayed on screen naming the workflow while the effect closed the popover the reader had
 * open, at the exact moment the last member finished. The question has one owner now, and it is the
 * populations a surface can NAME, never the unit tally.
 */
describe('hasLiveAgentActivity', () => {
    it('is true for a run that is between phases, when no unit is live', () => {
        expect(hasLiveAgentActivity({
            ...EMPTY_AGENT_ACTIVITY_COUNTS,
            total: 2,
            liveWorkflowRuns: 1,
        })).toBe(true);
    });

    it('is true for plain subagents and for background commands', () => {
        expect(hasLiveAgentActivity({ ...EMPTY_AGENT_ACTIVITY_COUNTS, live: 2, total: 2, liveSubagents: 2 })).toBe(true);
        expect(hasLiveAgentActivity({ ...EMPTY_AGENT_ACTIVITY_COUNTS, live: 1, total: 1, liveBackgroundTasks: 1 })).toBe(true);
    });

    /** Failure is a fact, not live work: the composer makes no claim about it (§4.6). */
    it('is false when the only thing left is a failure', () => {
        expect(hasLiveAgentActivity({ ...EMPTY_AGENT_ACTIVITY_COUNTS, failed: 2, total: 2 })).toBe(false);
    });

    /**
     * The unit tally is NOT the question. A non-zero `live` with nothing nameable cannot happen
     * through the real derivation, and this pins that the decider does not read it anyway — a gate
     * keyed on `live` is precisely the second decider FIX-F1 removed.
     */
    it('ignores the unit tally', () => {
        expect(hasLiveAgentActivity({ ...EMPTY_AGENT_ACTIVITY_COUNTS, live: 7, total: 7 })).toBe(false);
    });
});
