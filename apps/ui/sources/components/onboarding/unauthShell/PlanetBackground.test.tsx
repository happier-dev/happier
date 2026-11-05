import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';

const unistylesState = vi.hoisted(() => ({
    dark: false,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { dark: unistylesState.dark },
        rt: {},
    }),
    StyleSheet: {
        create: (input: unknown) => (typeof input === 'function' ? (input as () => unknown)() : input),
    },
}));

// PlanetBackground renders `expo-image`'s `Image` directly so we can pass
// `contentPosition` for the planet sphere to be visible inside our half-width
// brand pane. The mock turns it into a transparent host element whose props
// we can introspect.
vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('ExpoImage', props),
}));

vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));

import { PlanetBackground } from './PlanetBackground';

function sourceName(source: unknown): string | undefined {
    const value = typeof source === 'object' && source !== null && 'default' in source
        ? String((source as { default?: unknown }).default)
        : typeof source === 'string'
          ? source
          : undefined;
    return value ? value.split('/').pop() : undefined;
}

describe('PlanetBackground', () => {
    it('uses the light planet asset in light mode and a cover/anchored contentPosition so the sphere stays in view', async () => {
        unistylesState.dark = false;

        const screen = await renderScreen(<PlanetBackground variant="desktop" />);
        const image = screen.findByTestId('planet-background-desktop');

        expect(sourceName(image?.props.source)).toBe('planet-light.jpg');
        // The website's hero uses `object-position: 80% center` because the
        // planet sphere sits in the right portion of the source JPG. We carry
        // the same anchor here so the planet sphere is visible inside our
        // half-width left pane instead of being cropped off-screen.
        expect(image?.props.contentFit).toBe('cover');
        // expo-image's ImageContentPositionValue accepts numbers, `${n}px`, and `${n}%` strings only.
        // The literal string 'center' is invalid and silently ignored, so we use '50%' explicitly.
        expect(image?.props.contentPosition).toMatchObject({ left: '80%', top: '50%' });
    });

    it('renders the native mobile backdrop at the exact pixel rect that reproduces the web background-size:300% / center 20% recipe', async () => {
        unistylesState.dark = true;

        const screen = await renderScreen(<PlanetBackground variant="mobile" />);

        // The image is rendered lazily after the container is measured — drive
        // onLayout with a known container size so we can assert the computed
        // rect. 400 × 900 keeps the arithmetic legible.
        const frame = screen.findByTestId('planet-background-mobile-frame');
        expect(frame).toBeTruthy();
        // Wrap in act() so the onLayout-driven setState re-render is committed
        // before we query for the (lazily-rendered) image.
        act(() => {
            invokeTestInstanceHandler(
                frame!,
                'onLayout',
                { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 900 } } },
                'planet-background-mobile-frame',
            );
        });

        const image = screen.findByTestId('planet-background-mobile');
        expect(sourceName(image?.props.source)).toBe('planet-dark.jpg');
        // `contentFit: 'fill'` is intentional: the computed box already matches
        // the source aspect ratio (6144×4096 = 1.5), so the image maps 1:1 with
        // no distortion. This mirrors the web `background-size: 300%` (width
        // ×3, aspect-preserving height) rather than a 300%×300% cover crop.
        expect(image?.props.contentFit).toBe('fill');
        // A phone is taller than the 3× image (1200 / 1.5 = 800 < 900), so the image grows to its height:
        // no hard edge where the picture would stop short of the screen.
        // height = max(800, 900)                  = 900
        // width  = 900 × 1.5                      = 1350
        // left   = (400 − 1350) / 2               = -475  (center)
        // top    = 0.2 × (900 − 900)              = 0     (center 20%)
        expect(image?.props.style).toMatchObject({
            position: 'absolute',
            width: 1350,
            height: 900,
            left: -475,
            top: 0,
        });
    });
});
