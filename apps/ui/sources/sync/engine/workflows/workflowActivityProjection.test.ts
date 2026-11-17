import { describe, expect, it } from 'vitest';

import type { WorkflowActivityLiveFact } from '@/sync/domains/workflows/workflowActivityTypes';
import { createSocketApplyFrameScheduler } from '../sessions/socketApplyFrame';
import { createWorkflowActivityProjection } from './workflowActivityProjection';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/automationRunCause';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import type { AutomationRunLifecycleOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationRunLifecycle';

// requestAnimationFrame is the platform boundary; the real shared scheduler runs below it.
function frameBoundary() {
    const callbacks: Array<() => void> = [];
    return {
        scheduler: createSocketApplyFrameScheduler({
            requestFrame: () => callback => { callbacks.push(callback); },
            isPainting: () => true,
        }),
        frame() { for (const callback of callbacks.splice(0)) callback(); },
        pendingFrames: () => callbacks.length,
    };
}

function session(id: string, occurredAt: number): WorkflowActivityLiveFact {
    return { key: `session:${id}:started:1`, kind: 'session', sessionId: id,
        event: 'started', sourceRevision: 1, occurredAt, coverage: 'live' };
}

describe('shared Workflow activity projection', () => {
    it('keeps retained lifecycle sources exact and merges only a matching observed source occurrence', () => {
        const frame = frameBoundary();
        const projection = createWorkflowActivityProjection(frame.scheduler);
        const evidence = { v: 1, kind: 'runLifecycle', source: { kind: 'workflow_run', runId: 'same-id' },
            condition: 'terminal', sourceRevision: 2, occurredAt: 100 } as const;
        const child = (triggerId: string, occurrence: AutomationRunLifecycleOccurrenceEvidenceV1 = evidence) => createWorkflowRunSummaryFixture({ id: triggerId,
            origin: { kind: 'automation', automationId: 'a1', cause: AutomationRunCauseSchema.parse({ kind: 'trigger',
                triggerKind: 'runLifecycle', triggerId, triggerRevision: 1, occurredAt: occurrence.occurredAt,
                occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: occurrence }),
                evidence: { source: occurrence.source, condition: occurrence.condition, sourceRevision: occurrence.sourceRevision } }) } });
        const first = child('t1');
        const duplicate = child('t2');
        projection.applyRetained([first, duplicate]);
        frame.frame();
        expect(projection.getKeys()).toHaveLength(1);
        const key = projection.getKeys()[0]!;
        const retained = projection.getRow(key)!;
        expect(retained).toMatchObject({ coverage: 'retained_cause', sourceRevision: 2, occurredAt: 100 });
        expect(retained).not.toHaveProperty('state');
        projection.applyRetained([child('execution', { ...evidence, source: { kind: 'execution_run', machineId: 'machine', runId: 'same-id' } }),
            child('attention', { ...evidence, condition: 'needs_attention' }), child('revision', { ...evidence, sourceRevision: 3 })]);
        frame.frame();
        expect(projection.getKeys()).toHaveLength(4);
        const live = { key, kind: 'run', runId: 'same-id', event: 'terminal', sourceRevision: 2,
            state: 'succeeded', coverage: 'live', occurredAt: 90 } as const;
        projection.apply([live]);
        projection.applyRetained([first]);
        frame.frame();
        expect(projection.getRow(key)).toEqual(live);
        const keys = projection.getKeys();
        projection.applyRetained([duplicate]);
        frame.frame();
        expect(projection.getKeys()).toBe(keys);
        expect(projection.getRow(key)).toEqual(live);
        projection.dispose();
    });
    it('publishes a burst once per frame for both hosts and preserves unchanged row identities', () => {
        const frame = frameBoundary();
        const projection = createWorkflowActivityProjection(frame.scheduler);
        let columnPublications = 0;
        let companionPublications = 0;
        projection.subscribeKeys(() => { columnPublications++; });
        projection.subscribeKeys(() => { companionPublications++; });
        const first = session('first', 1);
        const second = session('second', 2);
        const third = session('third', 3);

        projection.apply([first]);
        projection.apply([second]);
        projection.apply([third]);
        expect(projection.getKeys()).toEqual([]);
        expect(columnPublications).toBe(0);
        expect(companionPublications).toBe(0);
        expect(frame.pendingFrames()).toBe(1);
        frame.frame();

        const keys = projection.getKeys();
        expect(keys).toEqual([third.key, second.key, first.key]);
        expect(columnPublications).toBe(1);
        expect(companionPublications).toBe(1);
        expect(projection.getRow(first.key)).toBe(first);

        // A repeated delivered tuple is not another occurrence or publication.
        projection.apply([{ ...second }]);
        frame.frame();
        expect(projection.getKeys()).toBe(keys);
        expect(projection.getRow(second.key)).toBe(second);
        expect(columnPublications).toBe(1);
        expect(companionPublications).toBe(1);
        projection.dispose();
    });

    it('notifies only the changed row while an existing key keeps its list identity', () => {
        const frame = frameBoundary();
        const projection = createWorkflowActivityProjection(frame.scheduler);
        const first = session('first', 1);
        const second = session('second', 2);
        projection.apply([first, second]);
        frame.frame();
        const keys = projection.getKeys();
        let firstPublications = 0;
        let secondPublications = 0;
        let keyPublications = 0;
        projection.subscribeRow(first.key, () => { firstPublications++; });
        projection.subscribeRow(second.key, () => { secondPublications++; });
        projection.subscribeKeys(() => { keyPublications++; });

        const changed = { ...first, sourceRevision: 2 };
        projection.apply([changed]);
        projection.apply([{ ...changed }]);
        frame.frame();

        expect(projection.getRow(first.key)).toEqual(changed);
        expect(projection.getRow(second.key)).toBe(second);
        expect(projection.getKeys()).toBe(keys);
        expect(firstPublications).toBe(1);
        expect(secondPublications).toBe(0);
        expect(keyPublications).toBe(0);
        projection.dispose();
    });

    it('keeps only the last change to an occurrence within a frame and orders equal times by key', () => {
        const frame = frameBoundary();
        const projection = createWorkflowActivityProjection(frame.scheduler);
        const first = session('a', 1);
        const second = session('b', 1);
        projection.apply([first, second]);
        projection.apply([{ ...first, sourceRevision: 2 }]);
        frame.frame();
        expect(projection.getKeys()).toEqual([second.key, first.key]);
        expect(projection.getRow(first.key)?.sourceRevision).toBe(2);
        projection.dispose();
    });

    it('does not publish an occurrence that returns to its committed value before the frame', () => {
        const frame = frameBoundary();
        const projection = createWorkflowActivityProjection(frame.scheduler);
        const first = session('first', 1);
        projection.apply([first]);
        frame.frame();
        let publications = 0;
        projection.subscribeRow(first.key, () => { publications++; });
        projection.apply([{ ...first, sourceRevision: 2 }]);
        projection.apply([{ ...first }]);
        frame.frame();
        expect(projection.getRow(first.key)).toBe(first);
        expect(publications).toBe(0);
        projection.dispose();
    });

    it('cancels its pending frame and releases row observers when its lifetime ends', () => {
        const frame = frameBoundary();
        const projection = createWorkflowActivityProjection(frame.scheduler);
        const first = session('first', 1);
        let publications = 0;
        projection.subscribeKeys(() => { publications++; });
        projection.subscribeRow(first.key, () => { publications++; });
        projection.apply([first]);
        projection.dispose();
        frame.frame();
        expect(projection.getKeys()).toEqual([]);
        expect(projection.getRow(first.key)).toBeUndefined();
        expect(publications).toBe(0);
    });
});
