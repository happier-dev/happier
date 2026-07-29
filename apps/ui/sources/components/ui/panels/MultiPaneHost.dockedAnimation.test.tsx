import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from './panelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedAnimatedInitialValues: number[] = [];
let capturedTimingConfigs: any[] = [];
let capturedAnimatedValues: any[] = [];

installPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            Animated: {
                Value: function Value(this: any, initial: number) {
                    capturedAnimatedInitialValues.push(initial);
                    capturedAnimatedValues.push(this);
                    this.__value = initial;
                    this.setValue = (value: number) => {
                        this.__value = value;
                    };
                    this.interpolate = (config: any) => ({
                        __interpolateConfig: config,
                        __valueRef: this,
                    });
                },
                timing: (_value: any, config: any) => {
                    capturedTimingConfigs.push(config);
                    return { start: () => undefined };
                },
            },
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

describe('MultiPaneHost docked pane animation', () => {
    beforeEach(() => {
        capturedAnimatedInitialValues = [];
        capturedTimingConfigs = [];
        capturedAnimatedValues = [];
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts docked right/details pane animations from hidden progress and animates their dock width', async () => {
        const { MultiPaneHost } = await import('./MultiPaneHost');

        const screen = await renderScreen(
            <MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={<Details />}
                layout={{ kind: 'threePane', right: 'docked', details: 'docked' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        );

        expect(capturedAnimatedInitialValues.slice(0, 2)).toEqual([0, 0]);
        expect(capturedTimingConfigs.some((config) => config?.toValue === 1)).toBe(true);

        expect(findAnimatedDimensionOutputRange(screen, 'width', [0, 360])).toBe(true);
        expect(findAnimatedDimensionOutputRange(screen, 'width', [0, 520])).toBe(true);
    });

    it('settles docked pane progress open when Animated.timing never completes', async () => {
        vi.useFakeTimers();
        const { MultiPaneHost } = await import('./MultiPaneHost');

        await renderScreen(
            <MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={<Details />}
                layout={{ kind: 'threePane', right: 'docked', details: 'docked' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        );

        expect(capturedAnimatedValues.slice(0, 2).map((value) => value.__value)).toEqual([0, 0]);

        await vi.advanceTimersByTimeAsync(250);

        expect(capturedAnimatedValues.slice(0, 2).map((value) => value.__value)).toEqual([1, 1]);
    });

    it('starts docked bottom pane animation from hidden progress and animates its dock height', async () => {
        const { MultiPaneHostWithBottom } = await import('./MultiPaneHostWithBottom');

        const screen = await renderScreen(
            <MultiPaneHostWithBottom
                main={<Main />}
                rightPane={null}
                detailsPane={null}
                layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
                bottomPane={<Bottom />}
                bottomPresentation="docked"
                bottomDockHeightPx={280}
                bottomDockMinHeightPx={200}
                bottomDockMaxHeightPx={600}
                onCloseBottom={() => {}}
                onCommitBottomDockHeightPx={() => {}}
            />,
        );

        expect(capturedAnimatedInitialValues[0]).toBe(0);
        expect(capturedTimingConfigs.some((config) => config?.toValue === 1)).toBe(true);

        expect(findAnimatedDimensionOutputRange(screen, 'height', [0, 280])).toBe(true);
    });
});

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function Details() {
    return React.createElement('Details');
}

function Bottom() {
    return React.createElement('Bottom');
}

function findAnimatedDimensionOutputRange(
    screen: Pick<Awaited<ReturnType<typeof renderScreen>>, 'findAll'>,
    key: 'width' | 'height',
    outputRange: readonly [number, number],
): boolean {
    return screen.findAll((node) => {
        const style = flattenStyle(node.props?.style);
        const candidate = style?.[key]?.__interpolateConfig?.outputRange;
        return Array.isArray(candidate) &&
            candidate.length === outputRange.length &&
            candidate.every((value, index) => value === outputRange[index]);
    }).length > 0;
}

function flattenStyle(style: any): any {
    if (!Array.isArray(style)) return style ?? null;
    return style.reduce((acc, value) => {
        if (!value || typeof value !== 'object') return acc;
        return { ...(acc ?? {}), ...value };
    }, null as any);
}
