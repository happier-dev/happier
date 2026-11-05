import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { describeWorkflowTriggerRunFold } from './workflowTriggerRunFoldPresentation';

const turnEnd = { kind: 'trigger', triggerId: 't', triggerRevision: 1, triggerKind: 'sessionLifecycle', occurrenceKey: 'o', occurredAt: 1,
    evidence: { event: 'parentTurnCompleted', sourceSessionId: 's', sourceTurnId: 'turn', policy: { kind: 'everyMatch' } } } as const as unknown as
    // Protocol brands its ids; the fixture spells the same wire shape the run summary carries.
    Parameters<typeof describeWorkflowTriggerRunFold>[0]['trigger'];
const settled = (result: unknown, extra: Partial<Parameters<typeof describeWorkflowTriggerRunFold>[0]> = {}) => describeWorkflowTriggerRunFold({
    catalogRef: 'builtin:keep-going', workflowTitle: null, turnCount: 3, run: { state: 'succeeded', workflowCustodyState: 'settled' },
    result, inputs: { maxRounds: 4, strikes: 3 }, secondOpinionDisagreed: false, trigger: turnEnd, ...extra,
});

describe('trigger-run fold presentation (07 S15)', () => {
    it('maps each Keep going stop arm to its neutral outcome', () => {
        expect(settled({ kind: 'stop_condition', arm: 0 })).toMatchObject({ verb: 'workflows.triggerRunFold.keptGoing',
            details: ['workflows.triggerRunFold.turns:{"count":3}', 'workflows.triggerRunFold.goalReached'], purpose: 'goal',
            meta: 'workflows.triggerRunFold.meta:{"workflow":"workflows.builtins.keepGoing.title","trigger":"workflows.triggerRunFold.trigger.turnEnds"}' });
        expect(settled({ kind: 'stop_condition', arm: 1 }).details[1]).toBe('workflows.triggerRunFold.outOfBudget');
        expect(settled({ kind: 'stop_condition', arm: 2 }, { inputs: { strikes: 2 } }).details[1])
            .toBe('workflows.triggerRunFold.noProgress:{"count":2}');
        // A round limit is said in rounds alone; a turn count beside it read as a second, disagreeing count (M8).
        expect(settled({ kind: 'exhausted', rounds: 2 }).details).toEqual(['workflows.triggerRunFold.stoppedAfterRounds:{"count":2}']);
        expect(settled({ kind: 'stop_condition', arm: 0 }, { secondOpinionDisagreed: true }).details[1])
            .toBe('workflows.triggerRunFold.secondOpinionDisagreed');
    });

    it('maps Review & converge outcomes and leaves the turn count out of its line', () => {
        const review = (result: unknown, inputs: Record<string, unknown> = { apply: 'fix' }) => settled(result,
            { catalogRef: 'builtin:review-and-converge', turnCount: 2, inputs });
        expect(review({ kind: 'stop_condition', arm: 0 })).toMatchObject({ verb: 'workflows.triggerRunFold.reviewed',
            details: ['workflows.triggerRunFold.convergedInRounds:{"count":3}'], purpose: 'review' });
        expect(review({ kind: 'stop_condition', arm: 1 }, { apply: 'report' }).details).toEqual(['workflows.triggerRunFold.findingsReported']);
        expect(review({ kind: 'exhausted', rounds: 3 }).details).toEqual(['workflows.triggerRunFold.reviewDidNotConverge:{"count":3}']);
    });

    it('names any other workflow by its own title and reads live or unread runs from the run state word', () => {
        const custom = settled(undefined, { catalogRef: null, workflowTitle: 'Nightly triage', run: { state: 'running', workflowCustodyState: null } });
        expect(custom).toMatchObject({ verb: 'Nightly triage', purpose: null });
        expect(custom.details).toEqual(['workflows.triggerRunFold.turns:{"count":3}', 'workflows.runState.running']);
        // No turns yet is no fact: a just-started fold says only its state, in the same anatomy (M8).
        expect(settled(undefined, { turnCount: 0, run: { state: 'running', workflowCustodyState: null } }).details).toEqual(['workflows.runState.running']);
        expect(settled(undefined, { catalogRef: null, workflowTitle: 'Nightly triage', turnCount: 0,
            run: { state: 'running', workflowCustodyState: null } }).details).toEqual(['workflows.runState.running']);
        // A settled Keep going whose result is not read yet never guesses an arm.
        expect(settled(undefined).details[1]).not.toMatch(/goalReached|outOfBudget|noProgress|stoppedAfter/);
        expect(settled({ kind: 'stop_condition', arm: 0 }, { run: { state: 'failed', workflowCustodyState: 'settled' } }).details[1])
            .not.toBe('workflows.triggerRunFold.goalReached');
    });
});
