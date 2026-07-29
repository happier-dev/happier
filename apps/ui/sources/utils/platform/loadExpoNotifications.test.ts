import { describe, expect, it, vi } from 'vitest';

import { AsyncTimeoutError } from '@/utils/timing/time';
import { loadExpoNotifications, resolveExpoNotificationsModule } from './loadExpoNotifications';

describe('resolveExpoNotificationsModule', () => {
    it('accepts a namespace object exposing expo-notifications members', () => {
        const module = { getPermissionsAsync: () => {} };
        expect(resolveExpoNotificationsModule(module)).toBe(module);
    });

    it('unwraps an interop default export', () => {
        const inner = { setBadgeCountAsync: () => {} };
        expect(resolveExpoNotificationsModule({ default: inner })).toBe(inner);
    });
});

describe('loadExpoNotifications', () => {
    it('resolves the module when the bundle loader settles', async () => {
        const module = { getPermissionsAsync: () => {} };
        await expect(
            loadExpoNotifications({ importModule: async () => module }),
        ).resolves.toBe(module);
    });

    it('rejects with AsyncTimeoutError when the bundle loader never settles', async () => {
        vi.useFakeTimers();
        try {
            const settled = loadExpoNotifications({
                importModule: () => new Promise(() => {}),
                timeoutMs: 5_000,
            })
                .then(() => ({ ok: true as const }))
                .catch((error: unknown) => ({ ok: false as const, error }));

            await vi.advanceTimersByTimeAsync(5_000);

            const result = await settled;
            if (result.ok) {
                throw new Error('Expected loadExpoNotifications to reject on a stalled bundle load');
            }
            expect(result.error).toBeInstanceOf(AsyncTimeoutError);
        } finally {
            vi.useRealTimers();
        }
    });

    it('propagates a bundle loader failure unchanged', async () => {
        const failure = new Error('module unavailable');
        await expect(
            loadExpoNotifications({ importModule: async () => { throw failure; } }),
        ).rejects.toBe(failure);
    });

    it('re-attempts the load after a stalled attempt instead of latching the failure', async () => {
        vi.useFakeTimers();
        try {
            const module = { getPermissionsAsync: () => {} };
            const importModule = vi.fn()
                .mockImplementationOnce(() => new Promise(() => {}))
                .mockImplementationOnce(async () => module);

            const stalled = loadExpoNotifications({ importModule, timeoutMs: 1_000 }).catch(() => 'stalled');
            await vi.advanceTimersByTimeAsync(1_000);
            expect(await stalled).toBe('stalled');

            await expect(loadExpoNotifications({ importModule, timeoutMs: 1_000 })).resolves.toBe(module);
            expect(importModule).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
