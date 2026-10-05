import { describe, expect, it } from 'vitest';

import {
    SESSION_HEADER_PULL_ARM_PX,
    SESSION_HEADER_PULL_OPEN_PX,
    resolveSessionHeaderPullFrame,
    resolveSessionHeaderPullRelease,
} from './sessionHeaderPullGesture';

describe('session header pull', () => {
    it('stays at rest until the drag passes the arming distance, so a light drag never moves the header', () => {
        const frame = resolveSessionHeaderPullFrame({ translationY: SESSION_HEADER_PULL_ARM_PX });
        expect(frame).toMatchObject({ progress: 0, ready: false, offset: 0 });
    });

    it('becomes ready exactly at the deliberate threshold past arming, with the header following under resistance', () => {
        const before = resolveSessionHeaderPullFrame({ translationY: SESSION_HEADER_PULL_ARM_PX + SESSION_HEADER_PULL_OPEN_PX - 1 });
        const at = resolveSessionHeaderPullFrame({ translationY: SESSION_HEADER_PULL_ARM_PX + SESSION_HEADER_PULL_OPEN_PX });
        expect(before.ready).toBe(false);
        expect(at).toMatchObject({ ready: true, progress: 1 });
        expect(at.offset).toBeGreaterThan(0);
        expect(at.offset).toBeLessThan(SESSION_HEADER_PULL_OPEN_PX);
    });

    it('never moves upward: an upward drag is not this gesture', () => {
        expect(resolveSessionHeaderPullFrame({ translationY: -80 })).toMatchObject({ progress: 0, ready: false, offset: 0 });
    });

    it('opens on release only past the threshold, and never when the system took the gesture away', () => {
        const past = SESSION_HEADER_PULL_ARM_PX + SESSION_HEADER_PULL_OPEN_PX + 4;
        expect(resolveSessionHeaderPullRelease({ translationY: past, cancelled: false })).toBe(true);
        expect(resolveSessionHeaderPullRelease({ translationY: past, cancelled: true })).toBe(false);
        expect(resolveSessionHeaderPullRelease({ translationY: SESSION_HEADER_PULL_ARM_PX + 20, cancelled: false })).toBe(false);
    });
});
