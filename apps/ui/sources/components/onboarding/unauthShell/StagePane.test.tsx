import * as React from 'react';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { stageVisualTokens } from '../tour/stage/stageVisualTokens';
import { StagePane } from './StagePane';

// Stub the asset import — the JPG never resolves through Vitest's transformer.
vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        const out: Record<string, unknown> = {};
        for (const entry of style) Object.assign(out, flattenStyle(entry));
        return out;
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('StagePane visual parity with the welcome brand pane', () => {
    it('grounds the stage planet with the same bottom fade the brand pane uses', async () => {
        const screen = await renderScreen(
            <StagePane mode="stage" accentHue="#FFB14A">
                <Text testID="demo-stage">demo stage</Text>
            </StagePane>,
        );

        const fade = screen.findByTestId('unauth-shell-stage-bottom-fade');
        expect(fade).toBeTruthy();
        // transparent -> the pane's own canvas, bottom-anchored (spec §1 / R1).
        expect(fade?.props.colors).toEqual([
            stageVisualTokens.horizon.light.backgroundColorTransparent,
            stageVisualTokens.horizon.light.backgroundColor,
        ]);
        const fadeStyle = flattenStyle(fade?.props.style);
        expect(fadeStyle.position).toBe('absolute');
        expect(fadeStyle.bottom).toBe(0);
        expect(fadeStyle.height).toBe(stageVisualTokens.horizon.bottomFadeHeight);
    });

    it('keeps the fade above the receding planet wallpaper and under the stage content', async () => {
        const screen = await renderScreen(
            <StagePane mode="stage" planetOpacity={0.74}>
                <Text testID="demo-stage">demo stage</Text>
            </StagePane>,
        );

        const pane = screen.findByTestId('unauth-shell-stage-pane');
        const order = (pane?.children ?? [])
            .flatMap((child) => typeof child === 'string' ? [] : [child.props.testID]);
        expect(order.indexOf('unauth-shell-stage-bottom-fade')).toBeGreaterThan(
            order.indexOf('unauth-shell-stage-wallpaper-host'),
        );
        expect(order.indexOf('unauth-shell-stage-content-host')).toBeGreaterThan(
            order.indexOf('unauth-shell-stage-bottom-fade'),
        );

        // The fade is canvas grounding, not part of the planet: it must not
        // recede with the wallpaper host on stage beats.
        const fadeStyle = flattenStyle(screen.findByTestId('unauth-shell-stage-bottom-fade')?.props.style);
        expect(fadeStyle.opacity).toBeUndefined();
    });

    it('renders the canonical welcome planet framing instead of a second horizon recipe', async () => {
        const screen = await renderScreen(
            <StagePane mode="stage">
                <Text testID="demo-stage">demo stage</Text>
            </StagePane>,
        );

        // `desktopComposition="horizon"` selected the journey-only 142%/center-86%
        // recipe, which anchored the disc centred and overflowed the pane. The
        // journey now frames the planet exactly like the welcome brand pane:
        // full-bleed cover anchored low-right (see PlanetBackground.test.tsx).
        const planet = screen.findByTestId('planet-background-desktop');
        expect(planet?.props.contentFit).toBe('cover');
        expect(planet?.props.contentPosition).toMatchObject({ left: '80%', top: '50%' });
    });
});
