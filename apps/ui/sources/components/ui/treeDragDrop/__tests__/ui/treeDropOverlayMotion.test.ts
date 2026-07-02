import { describe, expect, it } from 'vitest';

import { shouldSnapTreeDropOverlay } from '../../ui/treeDropOverlayMotion';

describe('shouldSnapTreeDropOverlay', () => {
    it('snaps on first appearance so the indicator never slides in from a stale position', () => {
        // Previously hidden -> now visible: appearing this drag.
        expect(shouldSnapTreeDropOverlay({ visible: true, previousVisible: false, reducedMotion: false })).toBe(true);
        // Unknown previous (mount / first reaction run): treat as first appearance.
        expect(shouldSnapTreeDropOverlay({ visible: true, previousVisible: null, reducedMotion: false })).toBe(true);
    });

    it('glides on subsequent moves within the same drag', () => {
        expect(shouldSnapTreeDropOverlay({ visible: true, previousVisible: true, reducedMotion: false })).toBe(false);
    });

    it('snaps while hidden so the next appearance starts with no offset', () => {
        expect(shouldSnapTreeDropOverlay({ visible: false, previousVisible: true, reducedMotion: false })).toBe(true);
        expect(shouldSnapTreeDropOverlay({ visible: false, previousVisible: false, reducedMotion: false })).toBe(true);
    });

    it('always snaps under reduced motion, even on subsequent moves', () => {
        expect(shouldSnapTreeDropOverlay({ visible: true, previousVisible: true, reducedMotion: true })).toBe(true);
    });
});
