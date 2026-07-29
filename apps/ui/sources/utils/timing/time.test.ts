import { describe, expect, it, vi } from 'vitest';
import { HappyError } from '@/utils/errors/errors';
import { AsyncTimeoutError, backoff, createBackoff, linearBackoffDelay, withTimeout } from './time';

describe('linearBackoffDelay', () => {
    it('clamps to the configured min/max range', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
        try {
            expect(linearBackoffDelay(0, 250, 1000, 8)).toBe(250);
            expect(linearBackoffDelay(8, 250, 1000, 8)).toBe(1000);
            expect(linearBackoffDelay(50, 250, 1000, 8)).toBe(1000);
        } finally {
            randomSpy.mockRestore();
        }
    });

    it('honors minimum delay even when jitter returns 0', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            expect(linearBackoffDelay(4, 250, 1000, 8)).toBe(250);
        } finally {
            randomSpy.mockRestore();
        }
    });
});

describe('withTimeout', () => {
    it('rejects with AsyncTimeoutError when the operation never settles', async () => {
        vi.useFakeTimers();
        try {
            const settled = withTimeout(new Promise<string>(() => {}), 1_000, 'never settles')
                .then((value) => ({ ok: true as const, value }))
                .catch((error: unknown) => ({ ok: false as const, error }));
            await vi.advanceTimersByTimeAsync(1_000);

            const result = await settled;
            if (result.ok) {
                throw new Error('Expected withTimeout to reject');
            }
            expect(result.error).toBeInstanceOf(AsyncTimeoutError);
            expect((result.error as AsyncTimeoutError).timeoutMs).toBe(1_000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resolves with the operation value before the deadline', async () => {
        await expect(withTimeout(Promise.resolve('ready'), 1_000, 'op')).resolves.toBe('ready');
    });

    it('propagates the operation rejection rather than the timeout', async () => {
        const failure = new Error('operation failed');
        await expect(withTimeout(Promise.reject(failure), 1_000, 'op')).rejects.toBe(failure);
    });

    it('does not leave an unhandled rejection when the operation rejects after timing out', async () => {
        vi.useFakeTimers();
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            let rejectLate: ((error: unknown) => void) | undefined;
            const late = new Promise<never>((_, reject) => { rejectLate = reject; });
            const settled = withTimeout(late, 500, 'late').catch(() => 'timed-out');
            await vi.advanceTimersByTimeAsync(500);
            expect(await settled).toBe('timed-out');

            rejectLate?.(new Error('late failure'));
            await vi.advanceTimersByTimeAsync(0);
            await Promise.resolve();
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
            vi.useRealTimers();
        }
    });

    it('skips the deadline entirely for a non-positive timeout', async () => {
        await expect(withTimeout(Promise.resolve('ready'), 0, 'op')).resolves.toBe('ready');
    });
});

describe('createBackoff', () => {
    it('does not console.warn by default when using the exported backoff', async () => {
        vi.useFakeTimers();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        try {
            const callback = vi.fn(async () => {
                throw new Error('fail');
            });

            const settled = backoff(callback)
                .then(() => ({ ok: true as const }))
                .catch(() => ({ ok: false as const }));
            await vi.runAllTimersAsync();

            const result = await settled;
            expect(result.ok).toBe(false);
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            randomSpy.mockRestore();
            warnSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it('does not retry endpoint offline HappyErrors by default', async () => {
        vi.useFakeTimers();
        try {
            const backoff = createBackoff({
                minDelay: 0,
                maxDelay: 0,
                maxFailureCount: 2,
            });
            const callback = vi.fn(async () => {
                throw new HappyError('offline', true, { kind: 'network', code: 'endpoint_offline' });
            });

            const settled = backoff(callback)
                .then(() => ({ ok: true as const }))
                .catch((error: unknown) => ({ ok: false as const, error }));
            await vi.runAllTimersAsync();

            const result = await settled;
            if (result.ok) {
                throw new Error('Expected backoff to reject');
            }
            expect(result.error).toBeInstanceOf(HappyError);
            expect(callback).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
