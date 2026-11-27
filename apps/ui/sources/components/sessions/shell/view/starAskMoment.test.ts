import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStarAskMoment } from './starAskMoment';

afterEach(() => vi.useRealTimers());

describe('session supporter ask moment', () => {
    it('waits for uninterrupted focused idle and suppresses a second ask in the same run', async () => {
        vi.useFakeTimers();
        const prepare = vi.fn(async () => 'star' as const);
        const show = vi.fn();
        let focused = true;
        const moment = createStarAskMoment();
        const candidate = { accountId: 'a', active: () => focused, eligible: () => true, prepare, show };
        moment.arm(candidate);
        await vi.advanceTimersByTimeAsync(20_000);
        moment.touch();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(prepare).not.toHaveBeenCalled();
        focused = false;
        moment.touch();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(prepare).not.toHaveBeenCalled();
        focused = true;
        moment.touch();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(show).toHaveBeenCalledWith('star');
        moment.arm(candidate);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(prepare).toHaveBeenCalledTimes(1);
    });

    it('does not show a result prepared after another task starts', async () => {
        vi.useFakeTimers();
        let resolve!: (value: 'star') => void;
        const show = vi.fn();
        const moment = createStarAskMoment();
        moment.arm({ accountId: 'a', active: () => true, eligible: () => true, prepare: () => new Promise((done) => { resolve = done; }), show });
        await vi.advanceTimersByTimeAsync(30_000);
        moment.disarm();
        resolve('star');
        await Promise.resolve();
        expect(show).not.toHaveBeenCalled();
    });
});
