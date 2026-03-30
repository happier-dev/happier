import { describe, expect, it, vi } from 'vitest';
import { HappyError } from '@/utils/errors/errors';
import { backoff, createBackoff, linearBackoffDelay } from './time';

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
