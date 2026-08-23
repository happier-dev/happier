export type UserRequestLeaseOwner = Readonly<{
    acquire(): () => void;
    hasActiveLease(): boolean;
    deferRoutineTeardown(teardown: () => void): boolean;
    cancelDeferredRoutineTeardown(): void;
    crossHardBoundary(teardown: () => void): void;
}>;

/**
 * The visibility/socket owner for in-flight user requests. Routine backgrounding
 * waits for requests to settle; explicit disconnect, pagehide, and freeze never do.
 */
export function createUserRequestLeaseOwner(): UserRequestLeaseOwner {
    let activeLeaseCount = 0;
    let deferredRoutineTeardown: (() => void) | null = null;

    const releaseOne = () => {
        if (activeLeaseCount === 0) return;
        activeLeaseCount -= 1;
        if (activeLeaseCount !== 0 || deferredRoutineTeardown === null) return;

        const teardown = deferredRoutineTeardown;
        deferredRoutineTeardown = null;
        teardown();
    };

    return {
        acquire() {
            activeLeaseCount += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                releaseOne();
            };
        },
        hasActiveLease() {
            return activeLeaseCount > 0;
        },
        deferRoutineTeardown(teardown) {
            if (activeLeaseCount === 0) {
                teardown();
                return false;
            }
            deferredRoutineTeardown = teardown;
            return true;
        },
        cancelDeferredRoutineTeardown() {
            deferredRoutineTeardown = null;
        },
        crossHardBoundary(teardown) {
            activeLeaseCount = 0;
            deferredRoutineTeardown = null;
            teardown();
        },
    };
}
