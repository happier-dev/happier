import { describe, expect, it } from 'vitest';
import { projectSessionTaskProgressV1, projectSessionWorkDisplayV1, type SessionWorkDisplayItemV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary';
import type { SessionWorkStateV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';

import { projectSessionAgentPlan } from './sessionAgentPlan';

const todo = (id: string, title: string, status: SessionWorkDisplayItemV1['status']): SessionWorkDisplayItemV1 => ({
    id, title, status, kind: 'todo',
});

function planFor(items: readonly SessionWorkDisplayItemV1[]) {
    return projectSessionAgentPlan(items, projectSessionTaskProgressV1(items));
}

describe('projectSessionAgentPlan', () => {
    it('renders the Session task order and consumes the work owner’s progress', () => {
        const work: SessionWorkStateV1 = {
            v: 1, backendId: 'claude', updatedAt: 1,
            items: [
                { id: 'goal', kind: 'goal', origin: 'vendor', title: 'Ship it', status: 'active', updatedAt: 1 },
                { id: 'todo', kind: 'todo', origin: 'vendor', title: 'Write test', status: 'complete', updatedAt: 1 },
                { id: 'task', kind: 'task', origin: 'happier', title: 'Run test', status: 'active', updatedAt: 1 },
            ],
        };
        const progress = projectSessionWorkDisplayV1(work)?.taskProgress;
        expect(projectSessionAgentPlan(work.items, progress)).toMatchObject({
            steps: [{ id: 'todo', text: 'Write test', status: 'done' }, { id: 'task', text: 'Run test', status: 'current' }],
            doneCount: 1, total: 2, currentStep: 2,
        });
    });

    it('has no plan until the agent has written a to-do list', () => {
        expect(projectSessionAgentPlan(undefined)).toBeNull();
        expect(planFor([])).toBeNull();
    });

    it('keeps the agent order and names the step it is on as N of M', () => {
        const plan = planFor([
            todo('a', 'Find why the modal remounts', 'complete'),
            todo('b', 'Key the modal by route', 'complete'),
            todo('c', 'Add a resize test', 'complete'),
            todo('d', 'Run the full UI suite', 'active'),
            todo('e', 'Push and open the PR', 'pending'),
        ]);

        expect(plan).toMatchObject({ doneCount: 3, total: 5, currentStep: 4 });
        expect(plan?.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'current', 'todo']);
        expect(plan?.steps[3]?.text).toBe('Run the full UI suite');
    });

    it('points at the next open step when nothing is marked in progress, and at none once all are done', () => {
        expect(planFor([
            todo('a', 'One', 'complete'),
            todo('b', 'Two', 'pending'),
        ])).toMatchObject({ doneCount: 1, total: 2, currentStep: null, nextStep: 2 });
        expect(planFor([
            todo('a', 'One', 'complete'),
            todo('b', 'Two', 'complete'),
        ])).toMatchObject({ doneCount: 2, total: 2, currentStep: null, nextStep: null });
    });

    it('returns the same projection for an unchanged list so the card does not re-render', () => {
        const list = [todo('a', 'One', 'active')];
        expect(planFor(list)).toBe(planFor(list));
    });
});
