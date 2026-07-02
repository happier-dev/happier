import { describe, expect, it, vi } from 'vitest';

type NativeUpdateFailureLoggerModule = Readonly<{
    logNativeUpdateFetchFailure: (
        error: unknown,
        logger: Readonly<{ log: (message: string) => void }>,
    ) => void;
}>;

function isNativeUpdateFailureLoggerModule(value: unknown): value is NativeUpdateFailureLoggerModule {
    return (
        typeof value === 'object'
        && value !== null
        && typeof (value as { logNativeUpdateFetchFailure?: unknown }).logNativeUpdateFetchFailure === 'function'
    );
}

async function loadNativeUpdateFailureLoggerModule(): Promise<NativeUpdateFailureLoggerModule | null> {
    const modulePath = './logNativeUpdateFetchFailure';
    const loaded: unknown = await import(modulePath).catch(() => null);
    return isNativeUpdateFailureLoggerModule(loaded) ? loaded : null;
}

describe('logNativeUpdateFetchFailure', () => {
    it('logs background native update failures without writing to console error', async () => {
        const mod = await loadNativeUpdateFailureLoggerModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const logger = { log: vi.fn() };
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const error = new Error('Timed out waiting for server reachability');
        error.name = 'ServerFetchConnectivityTimeoutError';

        mod.logNativeUpdateFetchFailure(error, logger);

        expect(logger.log).toHaveBeenCalledWith(
            '[fetchNativeUpdate] Error: ServerFetchConnectivityTimeoutError: Timed out waiting for server reachability',
        );
        expect(consoleError).not.toHaveBeenCalled();

        consoleError.mockRestore();
    });
});
