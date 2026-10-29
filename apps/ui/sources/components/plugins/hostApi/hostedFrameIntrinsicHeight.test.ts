import { describe, expect, it, vi } from 'vitest';

import {
    createHostedFrameIntrinsicHeightReporter,
    readHostedFrameIntrinsicHeight,
} from './hostedFrameIntrinsicHeight';

describe('hosted frame intrinsic-height reports', () => {
    it('parses only a finite positive height', () => {
        expect(readHostedFrameIntrinsicHeight({ height: 320 })).toBe(320);
        expect(readHostedFrameIntrinsicHeight({ height: Number.NaN })).toBeNull();
        expect(readHostedFrameIntrinsicHeight({ height: -1 })).toBeNull();
        expect(readHostedFrameIntrinsicHeight({ height: '320' })).toBeNull();
        expect(readHostedFrameIntrinsicHeight(undefined)).toBeNull();
    });

    it('publishes only the latest valid report in one display frame and retires pending work', () => {
        const scheduled = new Map<number, () => void>();
        let nextHandle = 1;
        const publish = vi.fn();
        const cancelFrame = vi.fn((handle: number) => { scheduled.delete(handle); });
        const reporter = createHostedFrameIntrinsicHeightReporter({
            publish,
            scheduleFrame: (callback) => {
                const handle = nextHandle++;
                scheduled.set(handle, callback);
                return handle;
            },
            cancelFrame,
        });

        expect(reporter.readPublishedHeight()).toBeNull();
        expect(reporter.report(120)).toBe(true);
        expect(reporter.report(240)).toBe(true);
        expect(reporter.report(Number.NaN)).toBe(false);
        expect(reporter.report(0)).toBe(false);
        expect(scheduled).toHaveLength(1);
        expect(reporter.readPublishedHeight()).toBeNull();
        scheduled.values().next().value?.();
        expect(publish).toHaveBeenCalledOnce();
        expect(publish).toHaveBeenCalledWith(240);
        expect(reporter.readPublishedHeight()).toBe(240);

        expect(reporter.report(360)).toBe(true);
        reporter.dispose();
        expect(reporter.readPublishedHeight()).toBeNull();
        expect(cancelFrame).toHaveBeenCalledOnce();
        expect(reporter.report(480)).toBe(false);
        expect(publish).toHaveBeenCalledOnce();
    });
});
