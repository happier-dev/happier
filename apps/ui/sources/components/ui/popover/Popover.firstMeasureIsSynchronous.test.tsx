import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/utils/web/radixCjs', () => {
    const React = require('react');
    return {
        requireRadixDismissableLayer: () => ({
            Branch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
        }),
    };
});

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            useWindowDimensions: () => ({ width: 390, height: 844 }),
            StyleSheet: {
                absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
            },
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
});

/**
 * A popover is invisible until its anchor rect lands: `portalOpacity` returns 0 while
 * `anchorRectState` is null, and the enter animation is gated on the same state. So every frame
 * spent before the FIRST measurement is dead time the user experiences as "the popover did not
 * open yet" — on every open, warm or cold.
 *
 * The anchor is already laid out when the popover opens (it is the element that was tapped), and
 * under Fabric `measure` resolves in-tick off the shadow tree. So the first measurement must not be
 * gated behind `requestAnimationFrame`. The retry ladder may still yield a frame BETWEEN attempts,
 * for the genuine case where layout settles late.
 */
describe('Popover (first measurement is not frame-gated)', () => {
    it('measures the anchor without waiting for a frame, so the reveal is not delayed by a rAF', async () => {
        const { Popover } = await import('./Popover');

        let anchorMeasureCalls = 0;
        const anchorRef = {
            current: {
                measure: (cb: any) => {
                    anchorMeasureCalls += 1;
                    cb(0, 0, 100, 40, 20, 700);
                },
            },
        } as any;

        const renders: Array<{ maxHeight: number }> = [];

        await withPopoverWebGlobals(async () => {
            // Queue frame callbacks WITHOUT running them: anything the popover defers to a frame
            // cannot make progress, so only work that is genuinely un-gated can complete.
            const queuedFrames: Array<() => void> = [];
            const previousRaf = (globalThis as any).requestAnimationFrame;
            (globalThis as any).requestAnimationFrame = (cb: () => void) => {
                queuedFrames.push(cb);
                return queuedFrames.length;
            };

            try {
                await renderScreen(
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        gap: 8,
                        maxHeightCap: 300,
                        backdrop: false,
                        children: (renderProps: any) => {
                            renders.push({ maxHeight: renderProps.maxHeight });
                            return React.createElement('PopoverChild');
                        },
                    }),
                );

                await flushHookEffects({ cycles: 1, turns: 8 });

                // No frame callback has run — anything still queued is, by definition, dead time
                // the user waits through before the popover can become visible.
                expect(anchorMeasureCalls).toBeGreaterThanOrEqual(1);
                expect(renders.at(-1)?.maxHeight).toBeGreaterThan(0);
            } finally {
                (globalThis as any).requestAnimationFrame = previousRaf;
            }
        });
    });
});
