import { describe, expect, it, vi } from 'vitest';

import { publishHomeAccountChange, publishHomeAccountChangeWake } from '@/sync/runtime/orchestration/homeAccountChange';

import {
    invalidateSessionListQueryHome,
    resolveSessionListQueryInvalidationForAccountChange,
    subscribeSessionListQueryHomeInvalidation,
} from './sessionListQueryInvalidation';

describe('filtered-list Account-change invalidation', () => {
    it('does not invalidate Session membership for a qualified Artifact-only receipt', () => {
        expect(resolveSessionListQueryInvalidationForAccountChange({
            serverId: 'home-a', entityIds: ['artifact-a'], changeKinds: ['artifact'],
        })).toBe('none');
    });

    it('keeps mixed and explicitly membership-changing Artifact wakes conservative', () => {
        expect(resolveSessionListQueryInvalidationForAccountChange({
            serverId: 'home-a', entityIds: ['artifact-a', 'session-a'], changeKinds: ['artifact', 'session'],
        })).toBe('all');
        expect(resolveSessionListQueryInvalidationForAccountChange({
            serverId: 'home-a', entityIds: ['artifact-a'], changeKinds: ['artifact'], sessionListQueryAffects: true,
        })).toBe('all');
    });

    it('invalidates only the mounted controller for an exact local deadline Home', () => {
        const invalidateA = vi.fn();
        const invalidateB = vi.fn();
        const dispose = subscribeSessionListQueryHomeInvalidation(() => new Map([
            ['home-a', { invalidate: invalidateA, retire: vi.fn() }],
            ['home-b', { invalidate: invalidateB, retire: vi.fn() }],
        ]));

        invalidateSessionListQueryHome('home-b');

        expect(invalidateA).not.toHaveBeenCalled();
        expect(invalidateB).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('invalidates only the mounted controller for the exact changed Home', () => {
        const invalidateA = vi.fn();
        const invalidateB = vi.fn();
        const dispose = subscribeSessionListQueryHomeInvalidation(() => new Map([
            ['home-a', { invalidate: invalidateA, retire: vi.fn() }],
            ['home-b', { invalidate: invalidateB, retire: vi.fn() }],
        ]));

        publishHomeAccountChange('home-b', ['session-1']);
        expect(invalidateA).not.toHaveBeenCalled();
        expect(invalidateB).toHaveBeenCalledTimes(1);

        dispose();
        publishHomeAccountChange('home-b', ['session-2']);
        expect(invalidateB).toHaveBeenCalledTimes(1);
    });

    it('obeys the canonical detailed decision and retains unknown conservative wakes', () => {
        const invalidate = vi.fn();
        const dispose = subscribeSessionListQueryHomeInvalidation(() => new Map([
            ['home-a', { invalidate, retire: vi.fn() }],
        ]));

        publishHomeAccountChange('home-a', ['self'], { sessionListQueryAffects: false });
        expect(invalidate).not.toHaveBeenCalled();

        publishHomeAccountChange('home-a', ['self'], { sessionListQueryAffects: true });
        expect(invalidate).toHaveBeenCalledTimes(1);

        publishHomeAccountChange('home-a');
        expect(invalidate).toHaveBeenCalledTimes(2);

        // Row-level Session writes reach only corpora whose structural selection may move.
        publishHomeAccountChange('home-a', ['session-1'], { sessionListQueryAffects: 'structural' });
        expect(invalidate).toHaveBeenCalledTimes(3);
        expect(invalidate).toHaveBeenLastCalledWith('structural');

        dispose();
    });
    it('leaves focused-Home row and Machine wakes to the consumed feed page: N wakes, 0 list re-queries', () => {
        const invalidate = vi.fn();
        const dispose = subscribeSessionListQueryHomeInvalidation(() => new Map([
            ['home-a', { invalidate, retire: vi.fn() }],
        ]));

        // A streamed turn and busy Machines publish many content-free wakes; each is
        // followed by the catch-up page that the canonical planner classifies.
        for (let index = 0; index < 10; index += 1) {
            publishHomeAccountChangeWake('home-a', {
                t: 'account-change', changeKinds: ['session'], entityIds: [`session-${index}`], sessionSystemRecords: [],
            }, 'catch-up-pending');
            publishHomeAccountChangeWake('home-a', {
                t: 'account-change', changeKinds: ['machine'], entityIds: [`machine-${index}`],
            }, 'catch-up-pending');
        }
        expect(invalidate).toHaveBeenCalledTimes(0);

        // The consumed page still re-queries a genuinely structural change.
        publishHomeAccountChange('home-a', ['session-1'], { feedPageConsumed: true, sessionListQueryAffects: true });
        expect(invalidate).toHaveBeenCalledTimes(1);
        dispose();
    });
});
