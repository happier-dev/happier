// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { applyTranscriptNavigationRailMarkerMotionWrite } from './transcriptNavigationRailMotionWrite';

const MOTION = { opacity: 0.7, translateYPx: -1.5, widthPx: 16 } as const;

describe('applyTranscriptNavigationRailMarkerMotionWrite', () => {
    it('mutates inline DOM styles on web element handles', () => {
        const element = document.createElement('div');

        const result = applyTranscriptNavigationRailMarkerMotionWrite(element, MOTION);

        expect(result).toBe('dom');
        expect(element.style.width).toBe('16px');
        expect(element.style.opacity).toBe('0.7');
        expect(element.style.transform).toBe('translateY(-1.5px)');
    });

    it('uses setNativeProps on native host component handles', () => {
        const setNativeProps = vi.fn();

        const result = applyTranscriptNavigationRailMarkerMotionWrite({ setNativeProps }, MOTION);

        expect(result).toBe('set-native-props');
        expect(setNativeProps).toHaveBeenCalledWith({
            style: {
                opacity: 0.7,
                transform: [{ translateY: -1.5 }],
                width: 16,
            },
        });
    });

    it('reports unsupported handles instead of silently no-oping', () => {
        expect(applyTranscriptNavigationRailMarkerMotionWrite(null, MOTION)).toBe('unsupported');
        expect(applyTranscriptNavigationRailMarkerMotionWrite(undefined, MOTION)).toBe('unsupported');
        expect(applyTranscriptNavigationRailMarkerMotionWrite({}, MOTION)).toBe('unsupported');
    });
});
