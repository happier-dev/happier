import type { SessionWorkflowActivityHeadlineV1, SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { deriveWorkflowHeadlineAgentActivityEntries } from './fromWorkflowHeadline';

function run(over: Partial<SessionWorkflowRunHeadlineV1> & { runId: string }): SessionWorkflowRunHeadlineV1 {
    return {
        title: 'Ship the release',
        status: 'active',
        updatedAt: 1_000,
        recordRevision: 'r1',
        recordUpdatedAt: 1_000,
        totalAgents: 0,
        completedAgents: 0,
        ...over,
    } as SessionWorkflowRunHeadlineV1;
}

function headline(runs: SessionWorkflowRunHeadlineV1[]): SessionWorkflowActivityHeadlineV1 {
    return { v: 1, backendId: 'claude', updatedAt: 1_000, activeRuns: runs };
}

/**
 * RULING-11: the count-only headline states a run's size AND how much of it is done, and the number
 * a surface may speak is the difference — what is running now, not the roster the run started with.
 */
describe('deriveWorkflowHeadlineAgentActivityEntries — the run\'s live complement', () => {
    it('states the agents still running, not the roster total', () => {
        const [entry] = deriveWorkflowHeadlineAgentActivityEntries(
            headline([run({ runId: 'wf1', totalAgents: 5, completedAgents: 3 })]),
        );
        expect(entry?.liveAgentComplement).toBe(2);
    });

    it('states no agents for a run whose whole complement has finished', () => {
        const [entry] = deriveWorkflowHeadlineAgentActivityEntries(
            headline([run({ runId: 'wf1', totalAgents: 5, completedAgents: 5 })]),
        );
        expect(entry?.liveAgentComplement).toBe(0);
    });

    /** A producer that reports more completed than total must never yield a negative figure. */
    it('clamps an inconsistent producer at zero', () => {
        const [entry] = deriveWorkflowHeadlineAgentActivityEntries(
            headline([run({ runId: 'wf1', totalAgents: 5, completedAgents: 9 })]),
        );
        expect(entry?.liveAgentComplement).toBe(0);
    });

    it('keeps the run itself as the unit of work, whatever its complement', () => {
        const entries = deriveWorkflowHeadlineAgentActivityEntries(
            headline([run({ runId: 'wf1', totalAgents: 5, completedAgents: 5 })]),
        );
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: 'workflow_run', runId: 'wf1', status: 'running' });
    });
});
