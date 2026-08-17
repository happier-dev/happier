import { describe, expect, it } from 'vitest';

import { deriveAgentActivityCounts, type AgentActivityCountable } from './deriveAgentActivityCounts';

function run(overrides: Partial<AgentActivityCountable> = {}): AgentActivityCountable {
    return { id: 'workflow_run:wf_1', kind: 'workflow', status: 'running', runId: 'wf_1', ...overrides };
}

function agent(overrides: Partial<AgentActivityCountable> = {}): AgentActivityCountable {
    return { id: 'workflow_agent:wf_1:a1', kind: 'subagent', status: 'running', ...overrides };
}

describe('deriveAgentActivityCounts', () => {
    it('counts a run and its members once, not twice', () => {
        const counts = deriveAgentActivityCounts([
            run(),
            agent({ id: 'workflow_agent:wf_1:a1', parentId: 'workflow_run:wf_1' }),
            agent({ id: 'workflow_agent:wf_1:a2', parentId: 'workflow_run:wf_1' }),
        ]);

        // Two agents in flight, and the run that boxes them is not a third unit.
        expect(counts).toEqual({ live: 2, total: 2 });
    });

    it('recognises a container only when another entry names it as parent, never from the run itself', () => {
        // The same run, with nobody naming it: it is the only thing representing that work, so it
        // must stay a counted unit or a genuinely running workflow reports zero.
        const counts = deriveAgentActivityCounts([run()]);

        expect(counts).toEqual({ live: 1, total: 1 });
    });

    it('keeps a live run visible while every member it named has gone terminal', () => {
        const counts = deriveAgentActivityCounts([
            run(),
            agent({ id: 'workflow_agent:wf_1:a1', parentId: 'workflow_run:wf_1', status: 'succeeded' }),
        ]);

        // The run is still going; without the floor the count reads 0 between two phases.
        expect(counts.live).toBe(1);
        expect(counts.total).toBe(1);
    });

    it('attributes a locally derived agent to its live run through runId when no parent was named', () => {
        const counts = deriveAgentActivityCounts([
            run(),
            agent({ id: 'subagent:local-1', runId: 'wf_1' }),
        ]);

        // One agent in flight under one run — not one agent plus one run.
        expect(counts.live).toBe(1);
        // The run named nobody as parent, so it is not a container and both rows are units.
        expect(counts.total).toBe(2);
    });

    it('counts an agent under a FINISHED run as its own unit of live work', () => {
        const counts = deriveAgentActivityCounts([
            run({ status: 'succeeded' }),
            agent({ id: 'subagent:local-1', runId: 'wf_1' }),
        ]);

        // Nothing live is left to speak for it, so folding it into the finished run would silence
        // work that is still happening.
        expect(counts.live).toBe(1);
        expect(counts.total).toBe(2);
    });

    it('treats every non-terminal status as in flight, including a permission-blocked agent', () => {
        const counts = deriveAgentActivityCounts([
            agent({ id: 'a-queued', status: 'queued' }),
            agent({ id: 'a-starting', status: 'starting' }),
            agent({ id: 'a-waiting', status: 'waiting' }),
            agent({ id: 'a-blocked', status: 'blocked' }),
            agent({ id: 'a-done', status: 'succeeded' }),
            agent({ id: 'a-failed', status: 'failed' }),
            agent({ id: 'a-unknown', status: 'unknown' }),
        ]);

        expect(counts).toEqual({ live: 4, total: 7 });
    });

    it('reports a session with only a container run as having work, so its affordance still shows', () => {
        // `shouldShowSubagentsButton` reads `total > 0`; a kind-aware total that excluded a
        // container with no other rows would silently hide the Agents affordance.
        const counts = deriveAgentActivityCounts([
            run(),
            agent({ id: 'workflow_agent:wf_1:a1', parentId: 'workflow_run:wf_1', status: 'succeeded' }),
        ]);

        expect(counts.total).toBeGreaterThan(0);
    });

    it('returns the shared empty counts for an empty roster', () => {
        expect(deriveAgentActivityCounts([])).toEqual({ live: 0, total: 0 });
    });
});
