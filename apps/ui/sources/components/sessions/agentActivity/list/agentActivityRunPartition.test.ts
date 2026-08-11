import { describe, expect, it } from 'vitest';

import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

import { partitionAgentActivityRuns } from './agentActivityRunPartition';

/**
 * The grouping rule the compact work-state surface and the Agents pane share.
 *
 * It is tested here, on its own, rather than only through the two surfaces, because the failure it
 * prevents is invisible in a roster of plain subagents: it only bites when a workflow run is
 * present, and a surface-level fixture without one would certify a rule it never exercised.
 */

type Entry = Readonly<{
    id: string;
    kind: string;
    status: AgentActivityStatusV1;
    parentId?: string | null;
}>;

function entry(over: Partial<Entry> & Pick<Entry, 'id'>): Entry {
    return { kind: 'subagent', status: 'running', ...over };
}

describe('partitionAgentActivityRuns', () => {
    it('draws a live run as a panel and takes its members out of the flat list', () => {
        const result = partitionAgentActivityRuns([
            entry({ id: 'run', kind: 'workflow_run', status: 'running' }),
            entry({ id: 'a', kind: 'workflow_agent', parentId: 'run' }),
            entry({ id: 'b', kind: 'workflow_agent', parentId: 'run' }),
            entry({ id: 'loose' }),
        ]);

        // The failure this prevents: the run header lists its two agents AND the flat list lists
        // them again, so a two-agent workflow reads as four units of work on one surface.
        expect(result.runEntries.map((item) => item.id)).toEqual(['run']);
        expect(result.listedEntries.map((item) => item.id)).toEqual(['loose']);
    });

    it('keeps a member whose run is not being drawn, and the run with it', () => {
        // A finished run is not drawn as a panel, so its agents must stay in the list rather than
        // disappearing into a container that is not on screen — and so must the run, which is the
        // only row that can state the run-level outcome.
        const result = partitionAgentActivityRuns([
            entry({ id: 'run', kind: 'workflow_run', status: 'succeeded' }),
            entry({ id: 'a', kind: 'workflow_agent', status: 'succeeded', parentId: 'run' }),
        ]);

        expect(result.runEntries).toEqual([]);
        expect(result.listedEntries.map((item) => item.id)).toEqual(['run', 'a']);
    });

    it('restricts the whole partition to work in flight when the surface is the compact one', () => {
        const entries = [
            entry({ id: 'live' }),
            entry({ id: 'blocked-on-a-person', status: 'waiting' }),
            entry({ id: 'done', status: 'succeeded' }),
            entry({ id: 'run', kind: 'workflow_run', status: 'running' }),
        ];

        const compact = partitionAgentActivityRuns(entries, { liveOnly: true });
        expect(compact.runEntries.map((item) => item.id)).toEqual(['run']);
        // `waiting` is live work and must survive the filter — it is the case the deleted attention
        // model used to route somewhere else entirely.
        expect(compact.listedEntries.map((item) => item.id)).toEqual(['live', 'blocked-on-a-person']);

        const expanded = partitionAgentActivityRuns(entries);
        expect(expanded.listedEntries.map((item) => item.id))
            .toEqual(['live', 'blocked-on-a-person', 'done']);
    });

    /**
     * §4.7: FINISHED holds every terminal state, INCLUDING failed. A terminal run is not drawn as a
     * panel, so if it were also kept out of the list it would exist in the counts and nowhere on
     * screen — and a workflow that failed before naming a single agent would disappear entirely.
     * The run-level status word has no other home: a member row cannot say the run failed.
     */
    it('lists a terminal run so its own outcome is still visible', () => {
        const result = partitionAgentActivityRuns([
            entry({ id: 'finished-run', kind: 'workflow_run', status: 'failed' }),
        ]);

        expect(result.runEntries).toEqual([]);
        expect(result.listedEntries.map((item) => item.id)).toEqual(['finished-run']);
    });

    it('lists a terminal run beside a live one that is drawn as a panel', () => {
        const result = partitionAgentActivityRuns([
            entry({ id: 'live-run', kind: 'workflow_run', status: 'running' }),
            entry({ id: 'member', kind: 'workflow_agent', parentId: 'live-run' }),
            entry({ id: 'done-run', kind: 'workflow_run', status: 'succeeded' }),
        ]);

        expect(result.runEntries.map((item) => item.id)).toEqual(['live-run']);
        // The drawn run and its member are out; the terminal run stays, because nothing else on
        // screen carries its outcome.
        expect(result.listedEntries.map((item) => item.id)).toEqual(['done-run']);
    });
});
