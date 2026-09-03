import { describe, expect, it, vi } from 'vitest';

import { disposeUndiciDispatcherForTestTeardown } from './undiciDispatcherCleanup';

describe('disposeUndiciDispatcherForTestTeardown', () => {
    it('destroys pending dispatcher work instead of waiting for graceful close', async () => {
        const close = vi.fn(async () => undefined);
        const destroy = vi.fn(async () => undefined);

        await disposeUndiciDispatcherForTestTeardown({ close, destroy });

        expect(destroy).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
    });

    it('falls back to close when the runtime does not expose destroy', async () => {
        const close = vi.fn(async () => undefined);

        await disposeUndiciDispatcherForTestTeardown({ close });

        expect(close).toHaveBeenCalledOnce();
    });
});
