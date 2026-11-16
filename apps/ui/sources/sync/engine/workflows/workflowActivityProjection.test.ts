import { describe, expect, it } from 'vitest';

import type { WorkflowActivityLiveFact } from '@/sync/domains/workflows/workflowActivityTypes';
import { createSocketApplyFrameScheduler } from '../sessions/socketApplyFrame';
import { createWorkflowActivityProjection } from './workflowActivityProjection';

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
