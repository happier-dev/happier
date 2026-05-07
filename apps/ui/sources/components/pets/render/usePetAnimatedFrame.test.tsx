import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { PET_ANIMATION_ROWS_V1 } from '@happier-dev/protocol';
import { PET_ANIMATION_TICK_MS } from '@/components/pets/animation/petAnimationPlaybackConfig';

import { usePetAnimatedFrame } from './usePetAnimatedFrame';

function totalDurationMs(state: string): number {
    const row = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === state);
    if (!row) throw new Error(`Missing pet animation row for ${state}`);
    return row.durationsMs.reduce((sum, value) => sum + value, 0);
}

describe('usePetAnimatedFrame', () => {
    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('keeps idle on the first frame until the 6x idle duration elapses', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const idle = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === 'idle');
        expect(idle?.durationsMs).toEqual([280, 110, 110, 140, 140, 320]);
        const firstIdleDurationMs = idle?.durationsMs[0] ?? 0;

        const hook = await renderHook(() => usePetAnimatedFrame({
            state: 'idle',
            reducedMotion: false,
        }));

        await act(async () => {
            vi.advanceTimersByTime((firstIdleDurationMs * 6) - 1);
        });
        expect(hook.getCurrent()).toMatchObject({ state: 'idle', frame: 0 });

        await act(async () => {
            vi.advanceTimersByTime(PET_ANIMATION_TICK_MS + 1);
        });
        expect(hook.getCurrent()).toMatchObject({ state: 'idle', frame: 1 });
    });

    it('returns non-idle actions to idle after exactly 3 loops', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const runningDurationMs = totalDurationMs('running-right');

        const hook = await renderHook(() => usePetAnimatedFrame({
            state: 'running-right',
            reducedMotion: false,
        }));

        await act(async () => {
            vi.advanceTimersByTime((runningDurationMs * 3) - 1);
        });
        expect(hook.getCurrent().state).toBe('running-right');

        await act(async () => {
            vi.advanceTimersByTime(PET_ANIMATION_TICK_MS + 1);
        });
        expect(hook.getCurrent()).toMatchObject({ state: 'idle', row: 0, frame: 0 });
    });

    it('uses the requested state first frame when reduced motion is enabled', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const hook = await renderHook(() => usePetAnimatedFrame({
            state: 'failed',
            reducedMotion: true,
        }));

        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(hook.getCurrent()).toMatchObject({ state: 'failed', row: 5, frame: 0 });
    });

    it('does not tick animation frames while inactive', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const idle = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === 'idle');
        const firstIdleDurationMs = idle?.durationsMs[0] ?? 0;

        const hook = await renderHook(() => usePetAnimatedFrame({
            state: 'idle',
            reducedMotion: false,
            active: false,
        } as Parameters<typeof usePetAnimatedFrame>[0] & { active: boolean }));

        await act(async () => {
            vi.advanceTimersByTime((firstIdleDurationMs * 6) + PET_ANIMATION_TICK_MS + 1);
        });

        expect(hook.getCurrent()).toMatchObject({ state: 'idle', frame: 0 });
    });
});
