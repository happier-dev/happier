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
            Platform: {
                OS: 'android',
            },
            useWindowDimensions: () => ({ width: 1000, height: 800 }),
            StyleSheet: {
                absoluteFill: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                },
            },
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
});

describe('Popover (native sizing retries)', () => {
    it('retries measurement when an initial layout would yield maxHeight=0 (avoids 0-height popovers on native)', async () => {
        const { Popover } = await import('./Popover');

        let boundaryMeasureCalls = 0;
        const anchorRef = {
            current: {
                measure: (cb: any) => cb(0, 0, 100, 40, 0, 700),
            },
        } as any;
        const boundaryRef = {
            current: {
                measure: (cb: any) => {
                    boundaryMeasureCalls += 1;
                    // First measurement: boundary too small => availableBottom < 0 => maxHeight would compute to 0.
                    if (boundaryMeasureCalls === 1) return cb(0, 0, 1000, 200, 0, 0);
                    // Second measurement: stable boundary => popover should compute a non-zero maxHeight.
                    return cb(0, 0, 1000, 1200, 0, 0);
                },
            },
        } as any;

        const renders: Array<{ maxHeight: number }> = [];

        await withPopoverWebGlobals(async () => {
            const screen = await renderScreen(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    boundaryRef,
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

            expect(screen).toBeTruthy();
            expect(boundaryMeasureCalls).toBeGreaterThanOrEqual(2);
            expect(renders.at(-1)?.maxHeight).toBeGreaterThan(0);
        });
    });
});
