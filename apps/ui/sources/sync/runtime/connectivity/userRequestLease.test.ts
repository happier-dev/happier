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

    it('lets only requests in flight when routine teardown was deferred extend it', () => {
        const owner = createUserRequestLeaseOwner();
        const releaseUserRequest = owner.acquire();
        const teardown = vi.fn();
        expect(owner.deferRoutineTeardown(teardown)).toBe(true);

        // A hidden page keeps issuing overlapping background requests; each is
        // issued before the previous one settles, so the lease set never empties.
        let releasePrevious = owner.acquire();
        for (let index = 1; index < 20; index += 1) {
            const releaseNext = owner.acquire();
            releasePrevious();
            releasePrevious = releaseNext;
        }
        expect(teardown).not.toHaveBeenCalled();

        releaseUserRequest();
        expect(teardown).toHaveBeenCalledOnce();

        releasePrevious();
        expect(teardown).toHaveBeenCalledOnce();
    });

    it('keeps the first deferral boundary when routine backgrounding is reported twice', () => {
        const owner = createUserRequestLeaseOwner();
        const releaseUserRequest = owner.acquire();
        const firstTeardown = vi.fn();
        const secondTeardown = vi.fn();
        owner.deferRoutineTeardown(firstTeardown);
        const releaseLaterRequest = owner.acquire();

        expect(owner.deferRoutineTeardown(secondTeardown)).toBe(true);
        releaseUserRequest();

        expect(firstTeardown).not.toHaveBeenCalled();
        expect(secondTeardown).toHaveBeenCalledOnce();
        releaseLaterRequest();
        expect(secondTeardown).toHaveBeenCalledOnce();
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

    it('treats a hard boundary (pagehide/freeze) as tearing down immediately', () => {
        const owner = createUserRequestLeaseOwner();
        const release = owner.acquire();
        const routineTeardown = vi.fn();
        const hardTeardown = vi.fn();

        owner.deferRoutineTeardown(routineTeardown);
        owner.crossHardBoundary(hardTeardown);

        expect(hardTeardown).toHaveBeenCalledTimes(1);
        expect(routineTeardown).not.toHaveBeenCalled();
        expect(owner.hasActiveLease()).toBe(false);

        release();
        expect(hardTeardown).toHaveBeenCalledTimes(1);
    });

    it('does not let a retired request release a replacement request across a hard boundary', () => {
        const owner = createUserRequestLeaseOwner();
        const releaseRetired = owner.acquire();
        owner.crossHardBoundary(() => {});
        const releaseCurrent = owner.acquire();
        const teardown = vi.fn();
        owner.deferRoutineTeardown(teardown);

        releaseRetired();
        expect(teardown).not.toHaveBeenCalled();
        expect(owner.hasActiveLease()).toBe(true);

        releaseCurrent();
        expect(teardown).toHaveBeenCalledOnce();
    });
});
