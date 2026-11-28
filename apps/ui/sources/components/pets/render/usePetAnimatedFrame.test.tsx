import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { PET_ANIMATION_ROWS_V1 } from '@happier-dev/protocol/pets/constants';

import { usePetAnimatedFrame } from './usePetAnimatedFrame';

function totalDurationMs(state: string): number {
    const row = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === state);
    if (!row) throw new Error(`Missing pet animation row for ${state}`);
    return row.durationsMs.reduce((sum, value) => sum + value, 0);
}

/** Advance in small steps, one act per step, so each frame render can schedule its successor as a browser would. */
async function advanceLikeBrowser(totalMs: number): Promise<void> {
    for (let remaining = totalMs; remaining > 0; remaining -= 10) {
        await act(async () => {
            vi.advanceTimersByTime(Math.min(10, remaining));
        });
    }
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
            vi.advanceTimersByTime(1);
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

        await advanceLikeBrowser((runningDurationMs * 3) - 1);
        expect(hook.getCurrent().state).toBe('running-right');

        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(hook.getCurrent()).toMatchObject({ state: 'idle', row: 0, frame: 0 });
    });

    it('uses the canonical failed still frame when reduced motion is enabled (R11)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const hook = await renderHook(() => usePetAnimatedFrame({
            state: 'failed',
            reducedMotion: true,
        }));

        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(hook.getCurrent()).toMatchObject({ state: 'failed', row: 5, frame: 7 });
    });

    it('renders once per visible frame change across one idle loop and stops after an action settles', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const idle = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === 'idle');
        const idleLoopMs = totalDurationMs('idle') * 6;
        let renders = 0;
        const frames: number[] = [];
        const hook = await renderHook(() => {
            renders += 1;
            const frame = usePetAnimatedFrame({ state: 'idle', reducedMotion: false });
            if (frames[frames.length - 1] !== frame.frame) frames.push(frame.frame);
            return frame;
        });
        const rendersAtMount = renders;
        await advanceLikeBrowser(idleLoopMs);
        // Every frame of the loop is shown, in order, and the loop wraps to frame 0.
        expect(frames).toEqual([0, 1, 2, 3, 4, 5, 0]);
        expect(renders - rendersAtMount).toBe(idle?.frames ?? 0);
        expect(hook.getCurrent()).toMatchObject({ state: 'idle', frame: 0 });

        let actionRenders = 0;
        const action = await renderHook(() => {
            actionRenders += 1;
            return usePetAnimatedFrame({ state: 'waving', reducedMotion: false });
        });
        await advanceLikeBrowser(totalDurationMs('waving') * 3 + 5_000);
        expect(action.getCurrent()).toMatchObject({ state: 'idle', row: 0, frame: 0 });
        const settled = actionRenders;
        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        // A settled action shows a fixed frame: no further renders.
        expect(actionRenders).toBe(settled);
        // 4 frames x 3 loops, then the idle rest frame.
        expect(settled).toBeLessThanOrEqual(1 + 4 * 3 + 1);
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
            vi.advanceTimersByTime((firstIdleDurationMs * 6) + 1);
        });

        expect(hook.getCurrent()).toMatchObject({ state: 'idle', frame: 0 });
    });
});
