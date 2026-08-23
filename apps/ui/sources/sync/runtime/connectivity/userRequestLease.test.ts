import { describe, expect, it, vi } from 'vitest';

import { createUserRequestLeaseOwner } from './userRequestLease';

describe('user request lease owner', () => {
    it('defers routine hidden teardown until every in-flight user request settles', () => {
        const owner = createUserRequestLeaseOwner();
        const firstRelease = owner.acquire();
        const secondRelease = owner.acquire();
        const teardown = vi.fn();

        expect(owner.deferRoutineTeardown(teardown)).toBe(true);
        expect(teardown).not.toHaveBeenCalled();

        firstRelease();
        expect(teardown).not.toHaveBeenCalled();

        secondRelease();
        expect(teardown).toHaveBeenCalledTimes(1);
        expect(owner.hasActiveLease()).toBe(false);
    });

    it('cancels deferred hidden teardown when visibility returns', () => {
        const owner = createUserRequestLeaseOwner();
        const release = owner.acquire();
        const teardown = vi.fn();

        owner.deferRoutineTeardown(teardown);
        owner.cancelDeferredRoutineTeardown();
        release();

        expect(teardown).not.toHaveBeenCalled();
    });

    it('treats pagehide and freeze as hard boundaries', () => {
        for (const hardBoundary of ['pagehide', 'freeze'] as const) {
            const owner = createUserRequestLeaseOwner();
            const release = owner.acquire();
            const routineTeardown = vi.fn();
            const hardTeardown = vi.fn();

            owner.deferRoutineTeardown(routineTeardown);
            owner.crossHardBoundary(hardTeardown);

            expect(hardTeardown, hardBoundary).toHaveBeenCalledTimes(1);
            expect(routineTeardown, hardBoundary).not.toHaveBeenCalled();
            expect(owner.hasActiveLease(), hardBoundary).toBe(false);

            release();
            expect(hardTeardown, hardBoundary).toHaveBeenCalledTimes(1);
        }
    });
});
