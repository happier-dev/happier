import { act } from 'react-test-renderer';
import { vi } from 'vitest';

export type FlushHookEffectsOptions = Readonly<{
    cycles?: number;
    turns?: number;
    advanceTimersMs?: number;
    runOnlyPendingTimers?: boolean;
    runAllTimers?: boolean;
    frames?: number;
}>;

async function flushMicrotasks(turns: number): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
        await Promise.resolve();
    }
}

async function flushAnimationFrames(frames: number): Promise<void> {
    if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
        for (let frame = 0; frame < frames; frame += 1) {
            await vi.advanceTimersToNextTimerAsync();
        }
        return;
    }

    const requestAnimationFrameImpl = globalThis.requestAnimationFrame;
    if (typeof requestAnimationFrameImpl !== 'function') {
        return;
    }

    for (let frame = 0; frame < frames; frame += 1) {
        await new Promise<void>((resolve) => {
            requestAnimationFrameImpl(() => resolve());
        });
    }
}

export async function flushHookEffects(options: FlushHookEffectsOptions = {}): Promise<void> {
    const cycles = options.cycles ?? 4;
    const turns = options.turns ?? 2;
    const frames = options.frames ?? 0;

    await act(async () => {
        for (let cycle = 0; cycle < cycles; cycle += 1) {
            await flushMicrotasks(turns);
            if (typeof options.advanceTimersMs === 'number') {
                await vi.advanceTimersByTimeAsync(options.advanceTimersMs);
            }
            if (options.runOnlyPendingTimers) {
                vi.runOnlyPendingTimers();
            }
            if (options.runAllTimers) {
                await vi.runAllTimersAsync();
            }
            if (frames > 0) {
                await flushAnimationFrames(frames);
            }
            await flushMicrotasks(1);
        }
    });
}
