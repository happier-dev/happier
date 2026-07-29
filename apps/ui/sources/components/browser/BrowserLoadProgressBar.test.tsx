import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

import { BrowserLoadProgressBar } from './BrowserLoadProgressBar';

const TEST_ID = 'browser-progress';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    return (style && typeof style === 'object' ? style : {}) as Record<string, unknown>;
}

describe('BrowserLoadProgressBar', () => {
    it('renders the fill at the loading progress width while loading', async () => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={0.4} loading reducedMotion={false} />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        const fill = screen.findByTestId(`${TEST_ID}-fill`);
        expect(fill).not.toBeNull();
        expect(flattenStyle(fill?.props.style).width).toBe('40%');
    });

    it('renders nothing when not loading', async () => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={1} loading={false} reducedMotion={false} />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        // Not loading => no host output (neither the track nor the fill is rendered).
        expect(screen.findByTestId(`${TEST_ID}-fill`)).toBeNull();
        expect(screen.tree.toJSON()).toBeNull();
    });

    it('uses an indeterminate width when loading without a known progress value', async () => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={null} loading reducedMotion={false} />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        const fill = screen.findByTestId(`${TEST_ID}-fill`);
        expect(fill).not.toBeNull();
        // A null progress still shows a visible bar (not 0%) so the surface never reads as frozen.
        expect(flattenStyle(fill?.props.style).width).not.toBe('0%');
    });

    it('omits the glow style when reduced motion is preferred', async () => {
        const glowing = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={0.6} loading reducedMotion={false} />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        const glowingFill = flattenStyle(glowing.findByTestId(`${TEST_ID}-fill`)?.props.style);
        expect(glowingFill.shadowOpacity ?? glowingFill.shadowRadius).toBeTruthy();

        const reduced = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={0.6} loading reducedMotion />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        const reducedFill = flattenStyle(reduced.findByTestId(`${TEST_ID}-fill`)?.props.style);
        expect(reducedFill.shadowOpacity).toBeFalsy();
        expect(reducedFill.shadowRadius).toBeFalsy();
    });
});
