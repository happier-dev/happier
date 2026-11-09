export type UserRequestLeaseOwner = Readonly<{
    acquire(): () => void;
    hasActiveLease(): boolean;
    deferRoutineTeardown(teardown: () => void): boolean;
    cancelDeferredRoutineTeardown(): void;
    crossHardBoundary(teardown: () => void): void;
}>;

/**
 * The visibility/socket owner for in-flight user requests. Routine backgrounding
 * waits for the requests in flight when it was reported to settle; requests issued
 * afterwards (a hidden page's background reads and acknowledgements) never extend
 * that wait. A user flow that must survive backgrounding acquires its lease before
 * it starts. Explicit disconnect, pagehide, and freeze never wait.
 */
export function createUserRequestLeaseOwner(): UserRequestLeaseOwner {
    const activeLeases = new Set<() => void>();
    let deferredRoutineTeardown: (() => void) | null = null;
    // The leases a deferred routine teardown waits for: those held when it was deferred.
    const awaitedLeases = new Set<() => void>();

    const releaseOne = (release: () => void) => {
        if (!activeLeases.delete(release)) return;
        if (!awaitedLeases.delete(release)) return;
        if (awaitedLeases.size !== 0 || deferredRoutineTeardown === null) return;

        const teardown = deferredRoutineTeardown;
        deferredRoutineTeardown = null;
        teardown();
    };

    return {
        acquire() {
            const release = () => { releaseOne(release); };
            activeLeases.add(release);
            return release;
        },
        hasActiveLease() {
            return activeLeases.size > 0;
        },
        deferRoutineTeardown(teardown) {
            // A repeated report while already deferred (native 'inactive' then
            // 'background', or two visibility signals) keeps the first boundary.
            if (deferredRoutineTeardown === null) {
                for (const lease of activeLeases) awaitedLeases.add(lease);
            }
            if (awaitedLeases.size === 0) {
                deferredRoutineTeardown = null;
                teardown();
                return false;
            }
            deferredRoutineTeardown = teardown;
            return true;
        },
        cancelDeferredRoutineTeardown() {
            deferredRoutineTeardown = null;
            awaitedLeases.clear();
        },
        crossHardBoundary(teardown) {
            activeLeases.clear();
            awaitedLeases.clear();
            deferredRoutineTeardown = null;
            teardown();
        },
    };
}

// Sync's visibility policy and ApiSocket's acknowledgement lifecycle share one
// owner. Transport requests hold the same lease as longer UI operations, so a
// request already in flight when the page is hidden completes before teardown.
export const userRequestLeaseOwner = createUserRequestLeaseOwner();
