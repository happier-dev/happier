import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { motionTokens } from '@/components/ui/motion/motionTokens';
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

const motionPreference = vi.hoisted(() => ({ reduced: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => motionPreference.reduced,
}));

type CompositorCall = Readonly<{ keyframes: ReadonlyArray<Record<string, unknown>>; options: Record<string, unknown> }>;
let compositorCalls: CompositorCall[] = [];
// The web element behind each pane column: the compositor animation boundary (Web Animations API).
const paneColumnNodeMock = (element: Readonly<{ props: Record<string, unknown> }>) => element.props?.role !== 'region' ? null : {
    style: {},
    getAnimations: () => [],
    animate: (keyframes: ReadonlyArray<Record<string, unknown>>, options: Record<string, unknown>) => {
        compositorCalls.push({ keyframes, options });
        return { cancel: () => undefined, onfinish: null };
    },
};

// Load the real host graph before fake timers and the individual interaction budgets begin.
await import('./MultiPaneHost');

// The host's first presence belongs to the main column's drawer (closed here); details and right follow it.
const DETAILS_AND_RIGHT_PROGRESS = [1, 3] as const;

describe('MultiPaneHost docked pane animation', () => {
    beforeEach(() => {
        capturedAnimatedInitialValues = [];
        capturedTimingConfigs = [];
        capturedAnimatedValues = [];
        compositorCalls = [];
        motionPreference.reduced = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('never mounts a sidebar token while its retained surface closes', async () => {
        vi.useFakeTimers();
        const { MultiPaneHost } = await import('./MultiPaneHost');
        const tree = (open: boolean) => <MultiPaneHost
            main={<Main />}
            rightPane={open ? React.createElement('RightToken') : null}
            rightSurfaces={[{ id: 'files', placement: open ? 'side' : 'hidden', content: <Right /> }]}
            detailsPane={null}
            layout={{ main: 'docked', kind: 'twoPane', right: open ? 'docked' : 'hidden', details: 'hidden' }}
            rightDockWidthPx={360} detailsDockWidthPx={520}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
        />;
        const screen = await renderScreen(tree(true));
        expect(screen.root.findAllByType('RightToken')).toHaveLength(0);
        await screen.update(tree(false));
        expect(screen.root.findAllByType('RightToken')).toHaveLength(0);
        expect(screen.root.findAllByType(Right)).toHaveLength(1);
    });

    it('opens docked right/details panes at their dock widths and moves them on the compositor', async () => {
        const { MultiPaneHost } = await import('./MultiPaneHost');
        const tree = (open: boolean) => <MultiPaneHost
            main={<Main />}
            rightPane={open ? <Right /> : null}
            detailsPane={open ? <Details /> : null}
            // A docked pane that closes while its layout stays docked plays its exit (the host's retained-close path).
            layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }}
            rightDockWidthPx={360} detailsDockWidthPx={520}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
        />;

        const screen = await renderScreen(tree(true), { createNodeMock: paneColumnNodeMock });

        expect(capturedAnimatedInitialValues.slice(...DETAILS_AND_RIGHT_PROGRESS)).toEqual([0, 0]);
        // The open columns hold their dock widths from the first frame.
        expect(findPlainDimension(screen, 'width', 360)).toBe(true);
        expect(findPlainDimension(screen, 'width', 520)).toBe(true);
        // Each column fades and slides in over the pane motion.
        expect(compositorCalls).toHaveLength(2);
        for (const call of compositorCalls) {
            expect(call.keyframes[0]?.opacity).toBe(0);
            expect(call.keyframes.at(-1)?.opacity).toBe(1);
            expect(call.options).toMatchObject({ duration: motionTokens.durationMs.base, easing: motionTokens.easingCss.standard });
        }

        await screen.update(tree(false));
        // Closing plays the same motion back out while the columns keep their widths until they leave.
        expect(compositorCalls).toHaveLength(4);
        for (const call of compositorCalls.slice(2)) {
            expect(call.keyframes[0]?.opacity).toBe(1);
            expect(call.keyframes.at(-1)?.opacity).toBe(0);
        }
        expect(findPlainDimension(screen, 'width', 360)).toBe(true);
    });

    it('lays the page out once per open and close, never once per animation frame', async () => {
        const { MultiPaneHost } = await import('./MultiPaneHost');
        const screen = await renderScreen(<MultiPaneHost
            main={<Main />} rightPane={<Right />} detailsPane={<Details />}
            layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }}
            rightDockWidthPx={360} detailsDockWidthPx={520}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
        />, { createNodeMock: paneColumnNodeMock });

        // A layout property driven by the animation progress re-lays out the page (and the transcript) on every frame.
        expect(countProgressDrivenLayoutStyles(screen)).toBe(0);
    });

    it('opens docked panes at once under reduced motion', async () => {
        motionPreference.reduced = true;
        const { MultiPaneHost } = await import('./MultiPaneHost');
        const screen = await renderScreen(<MultiPaneHost
            main={<Main />} rightPane={<Right />} detailsPane={null}
            layout={{ main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' }}
            rightDockWidthPx={360} detailsDockWidthPx={520}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
        />, { createNodeMock: paneColumnNodeMock });

        expect(findPlainDimension(screen, 'width', 360)).toBe(true);
        expect(compositorCalls).toHaveLength(0);
    });

    it('settles docked pane progress open when Animated.timing never completes', async () => {
        vi.useFakeTimers();
        const { MultiPaneHost } = await import('./MultiPaneHost');

        await renderScreen(
            <MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={<Details />}
                layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        );

        expect(capturedAnimatedValues.slice(...DETAILS_AND_RIGHT_PROGRESS).map((value) => value.__value)).toEqual([0, 0]);

        await vi.advanceTimersByTimeAsync(250);

        expect(capturedAnimatedValues.slice(...DETAILS_AND_RIGHT_PROGRESS).map((value) => value.__value)).toEqual([1, 1]);
    });

    it('shows current open-pane content and callbacks while retaining the last content only for closing', async () => {
        vi.useFakeTimers();
        const { MultiPaneHost } = await import('./MultiPaneHost');
        const previous = vi.fn();
        const current = vi.fn();
        const paneProps = {
            main: <Main />, rightPane: null,
            layout: { main: 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' } as const,
            rightDockWidthPx: 360, detailsDockWidthPx: 520,
            onCloseRight: () => {}, onCloseDetails: () => {},
            onCommitRightDockWidthPx: () => {}, onCommitDetailsDockWidthPx: () => {},
        };
        const screen = await renderScreen(<MultiPaneHost {...paneProps}
            detailsPane={React.createElement('Pressable', { testID: 'current-pane-action', onPress: previous }, 'Previous value')} />);
        await screen.update(<MultiPaneHost {...paneProps}
            detailsPane={React.createElement('Pressable', { testID: 'current-pane-action', onPress: current }, 'Current value')} />);
        expect(screen.getTextContent()).toContain('Current value');
        expect(screen.getTextContent()).not.toContain('Previous value');
        await screen.pressByTestIdAsync('current-pane-action');
        expect(current).toHaveBeenCalledOnce();
        expect(previous).not.toHaveBeenCalled();
        await screen.update(<MultiPaneHost {...paneProps} detailsPane={null} />);
        expect(screen.getTextContent()).toContain('Current value');
        await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.durationMs.base); });
        expect(screen.findByTestId('current-pane-action')).toBeNull();
    });

    it('starts no pane animation when an open pane only receives new content', async () => {
        vi.useFakeTimers();
        const { MultiPaneHost } = await import('./MultiPaneHost');
        const tree = (label: string) => <MultiPaneHost
            main={<Main />} rightPane={null}
            detailsPane={React.createElement('DetailsToken', { label })}
            layout={{ main: 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' }}
            rightDockWidthPx={360} detailsDockWidthPx={520}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
        />;
        const screen = await renderScreen(tree('first'));
        await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.durationMs.base); });
        const startedWhileOpening = capturedTimingConfigs.length;

        // Every parent render hands the pane a new element; the pane is already open, so nothing moves.
        for (const label of ['second', 'third', 'fourth']) await screen.update(tree(label));

        expect(capturedTimingConfigs.length - startedWhileOpening).toBe(0);
        expect(capturedAnimatedValues.slice(...DETAILS_AND_RIGHT_PROGRESS).map((value) => value.__value)).toEqual([1, 0]);
    });

    it('starts docked bottom pane animation from hidden progress and animates its dock height', async () => {
        const { MultiPaneHostWithBottom } = await import('./MultiPaneHostWithBottom');

        const screen = await renderScreen(
            <MultiPaneHostWithBottom
                main={<Main />}
                rightPane={null}
                detailsPane={null}
                layout={{ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' }}
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

    it('does not use the native driver on web for overlay pane animations', async () => {
        const { MultiPaneHost } = await import('./MultiPaneHost');
        const { MultiPaneHostWithBottom } = await import('./MultiPaneHostWithBottom');

        await renderScreen(<>
            <MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={<Details />}
                layout={{ main: 'docked', kind: 'overlayStack', right: 'overlay', details: 'overlay' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />
            <MultiPaneHostWithBottom
                main={<Main />}
                rightPane={null}
                detailsPane={null}
                layout={{ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
                bottomPane={<Bottom />}
                bottomPresentation="overlay"
                bottomDockHeightPx={320}
                bottomDockMinHeightPx={200}
                bottomDockMaxHeightPx={600}
                onCloseBottom={() => {}}
                onCommitBottomDockHeightPx={() => {}}
            />
        </>);

        expect(capturedTimingConfigs.length).toBeGreaterThan(0);
        for (const config of capturedTimingConfigs) {
            expect(config.useNativeDriver).toBe(false);
        }
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

function findPlainDimension(
    screen: Pick<Awaited<ReturnType<typeof renderScreen>>, 'findAll'>,
    key: 'width' | 'height',
    value: number,
): boolean {
    // The pane column itself (its region), not the resizable content inside it.
    return screen.findAll((node) => node.props?.role === 'region' && flattenStyle(node.props?.style)?.[key] === value).length > 0;
}

function countProgressDrivenLayoutStyles(screen: Pick<Awaited<ReturnType<typeof renderScreen>>, 'findAll'>): number {
    const layoutKeys = ['width', 'height', 'minWidth', 'maxWidth', 'flexBasis', 'left', 'right', 'margin', 'marginLeft', 'marginRight'];
    return screen.findAll((node) => {
        const style = flattenStyle(node.props?.style);
        return layoutKeys.some((key) => style?.[key]?.__interpolateConfig !== undefined);
    }).length;
}

function flattenStyle(style: any): any {
    if (!Array.isArray(style)) return style ?? null;
    return style.reduce((acc, value) => {
        if (!value || typeof value !== 'object') return acc;
        return { ...(acc ?? {}), ...value };
    }, null as any);
}
