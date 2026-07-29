import { afterEach, describe, expect, it } from 'vitest';
import { Platform } from 'react-native';

import { renderHook } from '@/dev/testkit';

import { resolveOverlayMotionPreset, useOverlayMotionAnimation } from './overlayMotion';

const ORIGINAL_PLATFORM = Platform.OS;

afterEach(() => {
    Platform.OS = ORIGINAL_PLATFORM;
});

function styleOf(value: { style: unknown }): { opacity?: unknown; transform?: unknown } {
    return value.style as { opacity?: unknown; transform?: unknown };
}

// `popover`/`bottom` is the selection action bar's motion (slide up from the bottom).
const SLIDE_PRESET = resolveOverlayMotionPreset({ kind: 'popover', direction: 'bottom' });

describe('useOverlayMotionAnimation disableTransformOnWeb', () => {
    it('animates opacity only (no transform) on web so a child backdrop-filter survives', async () => {
        Platform.OS = 'web';
        const { getCurrent } = await renderHook(() => useOverlayMotionAnimation({
            visible: true,
            preset: SLIDE_PRESET,
            disableTransformOnWeb: true,
        }));
        const style = styleOf(getCurrent());
        // A non-`none` transform creates a CSS backdrop root that would defeat the glass blur.
        expect(style.transform).toBeUndefined();
        expect(style.opacity).toBeDefined();
    });

    it('keeps the slide transform on native even when the flag is set (native blur is transform-safe)', async () => {
        Platform.OS = 'ios';
        const { getCurrent } = await renderHook(() => useOverlayMotionAnimation({
            visible: true,
            preset: SLIDE_PRESET,
            disableTransformOnWeb: true,
        }));
        expect(styleOf(getCurrent()).transform).toBeDefined();
    });

    it('keeps the transform on web when the flag is not set', async () => {
        Platform.OS = 'web';
        const { getCurrent } = await renderHook(() => useOverlayMotionAnimation({
            visible: true,
            preset: SLIDE_PRESET,
        }));
        expect(styleOf(getCurrent()).transform).toBeDefined();
    });
});
