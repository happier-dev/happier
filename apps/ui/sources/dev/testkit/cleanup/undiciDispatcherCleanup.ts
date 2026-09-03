export type UndiciDispatcherForTestTeardown = Readonly<{
    close?: () => Promise<void> | void;
    destroy?: () => Promise<void> | void;
}>;

export async function disposeUndiciDispatcherForTestTeardown(
    dispatcher: UndiciDispatcherForTestTeardown | null | undefined,
): Promise<void> {
    if (!dispatcher) return;

    // Test-process teardown must not wait for leaked or still-pending network work to drain.
    // Undici's graceful close can remain pending indefinitely in that state; destroy aborts
    // outstanding work and releases the dispatcher resources deterministically.
    if (typeof dispatcher.destroy === 'function') {
        await dispatcher.destroy();
        return;
    }

    if (typeof dispatcher.close === 'function') {
        await dispatcher.close();
    }
}
