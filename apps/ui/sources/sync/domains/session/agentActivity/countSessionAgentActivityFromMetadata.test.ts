import { describe, expect, it } from 'vitest';

import {
    buildAgentActivityEntryId,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol';

import {
    makeSessionWorkflowActivityMetadata,
    makeSessionWorkflowRunHeadline,
} from '@/dev/testkit/fixtures/sessionWorkflowActivityFixtures';

import { countSessionAgentActivityFromMetadata } from './countSessionAgentActivityFromMetadata';
import { EMPTY_AGENT_ACTIVITY_COUNTS } from './deriveAgentActivityCounts';

/**
 * The SESSION LIST's count, from metadata alone.
 *
 * A list row has no transcript, so this is the only path by which a row can say how much work a
 * session has — and it is a live counting path with real users on it: the session-list row's
 * sentence and, through the same tally, every number the list draws.
 *
 * It had no owner test at all until RULING-12. Its only execution coverage was two incidental
 * assertions inside a surface test, and a lane report once cited a 17-case suite for it that did
 * not exist. It is a thin composition over two tested owners, which is exactly why the risk is that
 * nobody notices when the composition itself changes: reading BOTH headline keys would double count
 * every run, and reading neither would silently report a session as idle.
 *
 * So this pins the composition and the RULING-12 rows through it: one magnitude for one piece of
 * work, whichever headline the CLI published.
 */

const RUN_ID = 'wf1';
const RUN_ENTRY_ID = buildAgentActivityEntryId({ kind: 'workflow_run', runId: RUN_ID });

function countOnlyMetadata(over: Readonly<{
    totalAgents: number;
    completedAgents: number;
    status?: 'active' | 'failed';
}>): Record<string, unknown> {
    const run = makeSessionWorkflowRunHeadline({
        runId: RUN_ID,
        title: 'Ship the release',
        status: over.status ?? 'active',
        totalAgents: over.totalAgents,
        completedAgents: over.completedAgents,
    });
    return over.status === 'failed'
        ? makeSessionWorkflowActivityMetadata([], { recentRuns: [run] })
        : makeSessionWorkflowActivityMetadata([run]);
}

function member(agentId: string, status: SessionAgentActivityEntryV1['status']): SessionAgentActivityEntryV1 {
    return {
        entryId: buildAgentActivityEntryId({ kind: 'workflow_agent', runId: RUN_ID, agentId }),
        kind: 'workflow_agent',
        title: `Agent ${agentId}`,
        status,
        updatedAt: 2_000,
        runId: RUN_ID,
        parentId: RUN_ENTRY_ID,
    };
}

function unifiedMetadata(
    members: readonly SessionAgentActivityEntryV1[],
): Record<string, unknown> {
    const headline: SessionAgentActivityHeadlineV1 = {
        v: 1,
        backendId: 'claude',
        updatedAt: 2_000,
        activeEntries: [
            {
                entryId: RUN_ENTRY_ID,
                kind: 'workflow_run',
                title: 'Ship the release',
                status: 'running',
                updatedAt: 2_000,
                runId: RUN_ID,
            },
            ...members.filter((entry) => entry.status === 'running'),
        ],
        recentEntries: members.filter((entry) => entry.status !== 'running'),
    };
    return { sessionAgentActivityHeadlineV1: headline };
}

describe('countSessionAgentActivityFromMetadata', () => {
    /**
     * §5.2's degrade path, and the common one: the unified headline is published by the Claude
     * activity source only, so a Codex, Gemini or OpenCode session has no headline at all. Zero
     * renders nothing, which is right — a row must not invent work it cannot see.
     */
    it('counts nothing for a session whose CLI publishes no headline', () => {
        expect(countSessionAgentActivityFromMetadata(undefined)).toBe(EMPTY_AGENT_ACTIVITY_COUNTS);
        expect(countSessionAgentActivityFromMetadata(null)).toBe(EMPTY_AGENT_ACTIVITY_COUNTS);
        expect(countSessionAgentActivityFromMetadata({ somethingElse: 1 })).toBe(EMPTY_AGENT_ACTIVITY_COUNTS);
        expect(countSessionAgentActivityFromMetadata('not an object')).toBe(EMPTY_AGENT_ACTIVITY_COUNTS);
    });

    /**
     * RULING-12 on the count-only path: the row states the agents the producer says are moving,
     * not one per run. `live: 1` for a five-agent workflow is the understatement the chip beside it
     * never made.
     */
    it('counts a count-only run as the live complement its producer states', () => {
        expect(countSessionAgentActivityFromMetadata(countOnlyMetadata({ totalAgents: 5, completedAgents: 0 })))
            .toMatchObject({ live: 5, liveWorkflowRuns: 1, liveWorkflowAgents: 5, total: 1 });
        expect(countSessionAgentActivityFromMetadata(countOnlyMetadata({ totalAgents: 5, completedAgents: 3 })))
            .toMatchObject({ live: 2, liveWorkflowRuns: 1, liveWorkflowAgents: 2 });
    });

    /**
     * The floor. A run whose complement has reached zero is still running — the window between two
     * phases — and a row reading `0` beside a session that is working is the invisibility FIX-1
     * removed from the chip. The AGENT figure stays zero, because none of them is running.
     */
    it('never counts a running run as zero live work', () => {
        expect(countSessionAgentActivityFromMetadata(countOnlyMetadata({ totalAgents: 5, completedAgents: 5 })))
            .toMatchObject({ live: 1, liveWorkflowRuns: 1, liveWorkflowAgents: 0 });
        // A producer that states more completions than it launched is inconsistent, not negative.
        expect(countSessionAgentActivityFromMetadata(countOnlyMetadata({ totalAgents: 5, completedAgents: 9 })))
            .toMatchObject({ live: 1, liveWorkflowRuns: 1, liveWorkflowAgents: 0 });
    });

    /** The same two rules on the unified path, where the producer names its members instead. */
    it('counts a named run by the members that are still live', () => {
        expect(countSessionAgentActivityFromMetadata(unifiedMetadata([
            member('a', 'running'),
            member('b', 'running'),
            member('c', 'succeeded'),
            member('d', 'succeeded'),
            member('e', 'succeeded'),
        ]))).toMatchObject({ live: 2, liveWorkflowRuns: 1, liveWorkflowAgents: 2, liveSubagents: 0 });

        expect(countSessionAgentActivityFromMetadata(unifiedMetadata([
            member('a', 'succeeded'),
            member('b', 'succeeded'),
        ]))).toMatchObject({ live: 1, liveWorkflowRuns: 1, liveWorkflowAgents: 0 });
    });

    /**
     * Exactly one headline is read.
     *
     * Both keys project the SAME committed run snapshots, so a session whose CLI writes both — the
     * mixed-version window this composition exists for — would report every run twice if this read
     * both. The unified key wins and the older one is not consulted at all.
     */
    it('reads the unified headline only, never both keys', () => {
        const both = {
            ...unifiedMetadata([member('a', 'running'), member('b', 'running')]),
            ...countOnlyMetadata({ totalAgents: 5, completedAgents: 0 }),
        };

        expect(countSessionAgentActivityFromMetadata(both))
            .toMatchObject({ live: 2, liveWorkflowRuns: 1, liveWorkflowAgents: 2 });
    });

    /** A terminal run is a fact the row still carries, and it is not live work. */
    it('counts a failed run as failure and not as live work', () => {
        expect(countSessionAgentActivityFromMetadata(
            countOnlyMetadata({ totalAgents: 3, completedAgents: 0, status: 'failed' }),
        )).toMatchObject({ live: 0, failed: 1, total: 1, liveWorkflowRuns: 0, liveWorkflowAgents: 0 });
    });
});
