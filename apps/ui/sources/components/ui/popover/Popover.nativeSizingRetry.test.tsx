import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flushMicrotasks(times: number) {
    return new Promise<void>((resolve) => {
        let remaining = times;
        const step = () => {
            remaining -= 1;
            if (remaining <= 0) return resolve();
            queueMicrotask(step);
        };
        queueMicrotask(step);
    });
}

vi.mock('@/utils/web/radixCjs', () => {
    const React = require('react');
    return {
        requireRadixDismissableLayer: () => ({
            Branch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
        }),
    };
});

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'android' },
        useWindowDimensions: () => ({ width: 1000, height: 800 }),
        StyleSheet: {
            absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        },
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

describe('Popover (native sizing retries)', () => {
    it('retries measurement when an initial layout would yield maxHeight=0 (avoids 0-height popovers on native)', async () => {
        const { Popover } = await import('./Popover');

        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
            cb();
            return 0 as any;
        });

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

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
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

            // Let the initial + retry measurements settle.
            await flushMicrotasks(8);
        });

        expect(tree).toBeTruthy();
        expect(boundaryMeasureCalls).toBeGreaterThanOrEqual(2);
        expect(renders.at(-1)?.maxHeight).toBeGreaterThan(0);
    });
});

