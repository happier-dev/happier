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

function fillScale(screen: Awaited<ReturnType<typeof renderScreen>>): number | undefined {
    const transform = flattenStyle(screen.findByTestId(`${TEST_ID}-fill`)?.props.style).transform as
        | ReadonlyArray<Readonly<{ scaleX?: number }>>
        | undefined;
    return transform?.find((entry) => typeof entry.scaleX === 'number')?.scaleX;
}

// The Reanimated test double evaluates animated styles during render and has no frame loop, so a
// shared value written by an effect shows after the next render. `settle` re-renders the same props.
async function settle(screen: Awaited<ReturnType<typeof renderScreen>>, element: React.ReactElement) {
    await flushHookEffects({ cycles: 2, turns: 2 });
    // A new element (same props): React skips a re-render for the identical element reference.
    await screen.update(React.cloneElement(element));
    await flushHookEffects({ cycles: 2, turns: 2 });
}

describe('BrowserLoadProgressBar', () => {
    it('fills toward the reported progress while loading', async () => {
        const element = <BrowserLoadProgressBar testID={TEST_ID} progress={0.4} loadingState="loading" reducedMotion={false} />;
        const screen = await renderScreen(element);
        await settle(screen, element);
        expect(fillScale(screen)).toBeCloseTo(0.4);
    });

    it('renders nothing when the page is not loading', async () => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={1} loadingState="ready" reducedMotion={false} />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.tree.toJSON()).toBeNull();
    });

    it('drifts without claiming to be nearly done when the engine reports no progress', async () => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={null} loadingState="loading" reducedMotion={false} />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        const scale = fillScale(screen) ?? 0;
        expect(scale).toBeGreaterThan(0);
        expect(scale).toBeLessThan(1);
        expect(screen.findHostByTestId(TEST_ID)?.props.accessibilityValue).toBeUndefined();
        expect(screen.findHostByTestId(TEST_ID)?.props['aria-valuenow']).toBeUndefined();
    });

    it.each(['failed', 'idle'] as const)('removes the line without completing when navigation becomes %s', async (loadingState) => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={0.4} loadingState="loading" reducedMotion={false} />,
        );
        await screen.update(
            <BrowserLoadProgressBar testID={TEST_ID} progress={0.4} loadingState={loadingState} reducedMotion={false} />,
        );
        expect(screen.findHostByTestId(TEST_ID)).toBeNull();
    });

    it('settles instead of blinking off: on ready the line runs to the end and stays until it fades', async () => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={0.5} loadingState="loading" reducedMotion={false} />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        const ready = <BrowserLoadProgressBar testID={TEST_ID} progress={null} loadingState="ready" reducedMotion={false} />;
        await screen.update(ready);
        await settle(screen, ready);
        expect(fillScale(screen)).toBe(1);
    });

    it('starts the next load as a fresh line instead of reusing the finished one', async () => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={0.5} loadingState="loading" reducedMotion={false} />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        const ready = <BrowserLoadProgressBar testID={TEST_ID} progress={null} loadingState="ready" reducedMotion={false} />;
        await screen.update(ready);
        await settle(screen, ready);
        expect(fillScale(screen)).toBe(1);
        // The person clicks a link while the finished line is still fading.
        const next = <BrowserLoadProgressBar testID={TEST_ID} progress={0.2} loadingState="loading" reducedMotion={false} />;
        await screen.update(next);
        await settle(screen, next);
        expect(fillScale(screen)).toBeCloseTo(0.2);
    });

    it('under reduced motion disappears on ready with no travel', async () => {
        const screen = await renderScreen(
            <BrowserLoadProgressBar testID={TEST_ID} progress={0.5} loadingState="loading" reducedMotion />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        await screen.update(
            <BrowserLoadProgressBar testID={TEST_ID} progress={null} loadingState="ready" reducedMotion />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.tree.toJSON()).toBeNull();
    });
});
