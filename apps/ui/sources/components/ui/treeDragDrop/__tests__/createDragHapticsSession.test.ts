import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

import { createDragHapticsSession } from '../createDragHapticsSession';

vi.mock('expo-haptics', () => ({
    impactAsync: vi.fn(),
    selectionAsync: vi.fn(),
    notificationAsync: vi.fn(),
    AndroidHaptics: { Reject: 'reject', Context_Click: 'context', Segment_Tick: 'tick', Drag_Start: 'start' },
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
    NotificationFeedbackType: { Error: 'error', Success: 'success' },
}));

const originalPlatform = Platform.OS;
beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    vi.clearAllMocks();
});
afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
});

describe('createDragHapticsSession', () => {
    it('ticks for changed valid destinations, including reentry after a blocked destination', () => {
        const drag = createDragHapticsSession('slot:0');
        drag.updateDestination('slot:0');
        expect(Haptics.selectionAsync).not.toHaveBeenCalled();
        drag.updateDestination('slot:1');
        drag.updateDestination('slot:1');
        drag.updateDestination(null);
        drag.updateDestination(null);
        expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
        drag.updateDestination('slot:1');
        expect(Haptics.selectionAsync).toHaveBeenCalledTimes(2);
    });

    it('settles applied outcomes once and refuses explicit rejected moves', () => {
        const applied = createDragHapticsSession();
        applied.finish('applied');
        applied.finish('applied');
        expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
        const refused = createDragHapticsSession();
        refused.finish('refused');
        refused.finish('refused');
        expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    });

    it.each(['unchanged', 'unknown', 'cancel'] as const)('keeps %s endings silent and isolates a later drag', (outcome) => {
        const earlier = createDragHapticsSession();
        if (outcome === 'cancel') earlier.cancel();
        else earlier.finish(outcome);
        const later = createDragHapticsSession();
        earlier.updateDestination('slot:2');
        earlier.finish('applied');
        later.updateDestination('slot:1');
        expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
        expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
        expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    });
});
