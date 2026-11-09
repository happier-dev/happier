import * as React from 'react';
import { View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createRenderCommitCounter,
    flattenTestStyle,
    renderScreen,
    standardCleanup,
    useRenderCommitCounter,
} from '@/dev/testkit';
import {
    HorizontalSafeAreaProvider,
    HorizontalSafeAreaRoot,
    NavigatorSafeAreaBleed,
    ScreenBackdropBoundary,
    ScreenSafeAreaFrame,
    useHorizontalSafeArea,
    useHorizontalSafeAreaContentPadding,
    useScreenSafeAreaBackdrop,
    useScreenSafeAreaBleed,
} from './HorizontalSafeArea';

// Native rendering and OS presentation are the only mocked boundaries.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

afterEach(standardCleanup);

const FOLDED_INSETS = { top: 20, bottom: 12, left: 16, right: 84 };

function Header(props: Readonly<{ testID: string }>) {
    return <View testID={props.testID} style={useHorizontalSafeAreaContentPadding()} />;
}

function Backdrop(props: Readonly<{ color: string }>) {
    useScreenSafeAreaBackdrop(props.color);
    return null;
}

function Hero(props: Readonly<{ testID: string }>) {
    const bleed = useScreenSafeAreaBleed();
    return <View testID={props.testID} style={{
        marginLeft: -bleed.left,
        marginRight: -bleed.right,
        paddingLeft: bleed.left,
        paddingRight: bleed.right,
    }} />;
}

function ScreenTree(props: Readonly<{ children?: React.ReactNode; presentation?: 'modal' }>) {
    return <HorizontalSafeAreaProvider value={{ left: 16, right: 84, padded: true }}>
        <NavigatorSafeAreaBleed>
            <ScreenSafeAreaFrame presentation={props.presentation}>{props.children}</ScreenSafeAreaFrame>
        </NavigatorSafeAreaBleed>
    </HorizontalSafeAreaProvider>;
}

function frameStyle(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const frame = screen.findByType(ScreenSafeAreaFrame);
    const host = frame.findAll((node) => typeof node.type === 'string')[0];
    if (!host) throw new Error('Screen frame did not paint a native host');
    return flattenTestStyle(host.props.style);
}

// Resolve the effective inset through all native ancestors, so a second padding
// or a missing outer navigator bleed cannot hide behind a correct leaf prop.
function cumulativeInset(node: ReactTestInstance | null) {
    if (!node) throw new Error('Expected the layout probe to paint a native host');
    const result = { left: 0, right: 0 };
    for (let current: ReactTestInstance | null = node; current; current = current.parent) {
        if (typeof current.type !== 'string') continue;
        const style = flattenTestStyle(current.props.style);
        for (const edge of ['Left', 'Right'] as const) {
            const margin = style[`margin${edge}`];
            const padding = style[`padding${edge}`];
            result[edge === 'Left' ? 'left' : 'right'] +=
                (typeof margin === 'number' ? margin : 0) + (typeof padding === 'number' ? padding : 0);
        }
    }
    return result;
}

describe('horizontal safe-area screen ownership', () => {
    it('leaves zero-inset layouts and isolated surfaces unchanged', async () => {
        const screen = await renderScreen(<>
            <Header testID="isolated-controls" />
            <Hero testID="isolated-hero" />
            <HorizontalSafeAreaProvider value={{ left: 0, right: 0, padded: true }}>
                <NavigatorSafeAreaBleed>
                    <ScreenSafeAreaFrame presentation={undefined}>
                        <Header testID="portrait-controls" />
                        <Hero testID="portrait-hero" />
                    </ScreenSafeAreaFrame>
                </NavigatorSafeAreaBleed>
            </HorizontalSafeAreaProvider>
        </>);
        for (const testID of ['isolated-controls', 'isolated-hero', 'portrait-controls', 'portrait-hero']) {
            expect(cumulativeInset(screen.findHostByTestId(testID))).toEqual({ left: 0, right: 0 });
        }
    });

    it('reclaims each outer and inner navigator edge while padding leaf content exactly once', async () => {
        const screen = await renderScreen(<SafeAreaInsetsContext.Provider value={FOLDED_INSETS}>
            <HorizontalSafeAreaRoot>
                <NavigatorSafeAreaBleed>
                    <View testID="outer-background" />
                    <Header testID="outer-controls" />
                    <ScreenSafeAreaFrame presentation={undefined}>
                        <Header testID="outer-leaf" />
                        <NavigatorSafeAreaBleed>
                            <View testID="inner-background" />
                            <Header testID="inner-controls" />
                            <ScreenSafeAreaFrame presentation={undefined}>
                                <Header testID="inner-leaf" />
                            </ScreenSafeAreaFrame>
                        </NavigatorSafeAreaBleed>
                    </ScreenSafeAreaFrame>
                </NavigatorSafeAreaBleed>
            </HorizontalSafeAreaRoot>
        </SafeAreaInsetsContext.Provider>);

        for (const testID of ['outer-background', 'inner-background']) {
            expect(cumulativeInset(screen.findHostByTestId(testID))).toEqual({ left: 0, right: 0 });
        }
        for (const testID of ['outer-controls', 'outer-leaf', 'inner-controls', 'inner-leaf']) {
            expect(cumulativeInset(screen.findHostByTestId(testID))).toEqual({ left: 16, right: 84 });
        }
    });

    it('leaves UIKit-presented iOS modal content and hero geometry free of the parent stack inset', async () => {
        const screen = await renderScreen(<ScreenTree presentation="modal">
            <Header testID="modal-controls" />
            <Hero testID="modal-hero" />
            <Backdrop color="modal-canvas" />
        </ScreenTree>);
        expect(frameStyle(screen)).toMatchObject({ paddingLeft: 0, paddingRight: 0 });
        expect(frameStyle(screen).backgroundColor).toBeUndefined();
        expect(flattenTestStyle(screen.findHostByTestId('modal-controls')!.props.style)).toEqual({ paddingLeft: 0, paddingRight: 0 });
        expect(flattenTestStyle(screen.findHostByTestId('modal-hero')!.props.style)).toMatchObject({ paddingLeft: 0, paddingRight: 0 });
    });

    it('restores the previous screen backdrop as declarations unmount and isolates nested surfaces', async () => {
        function Backdrops(props: Readonly<{ overlay: boolean; base: boolean }>) {
            return <ScreenTree>
                {props.base ? <Backdrop key="base" color="canvas" /> : null}
                {props.overlay ? <Backdrop key="overlay" color="overlay" /> : null}
                <ScreenBackdropBoundary><Backdrop color="nested-pane" /></ScreenBackdropBoundary>
            </ScreenTree>;
        }
        const screen = await renderScreen(<Backdrops overlay base />);
        expect(frameStyle(screen).backgroundColor).toBe('overlay');
        await screen.update(<Backdrops overlay={false} base />);
        expect(frameStyle(screen).backgroundColor).toBe('canvas');
        await screen.update(<Backdrops overlay={false} base={false} />);
        expect(frameStyle(screen).backgroundColor).toBeUndefined();
    });

    it('lets only the screen-level hero cancel the actual frame inset', async () => {
        const screen = await renderScreen(<ScreenTree>
            <Hero testID="screen-hero" />
            <ScreenBackdropBoundary><Hero testID="pane-hero" /></ScreenBackdropBoundary>
        </ScreenTree>);
        const frame = frameStyle(screen);
        const hero = flattenTestStyle(screen.findHostByTestId('screen-hero')!.props.style);
        expect(hero).toMatchObject({ paddingLeft: 16, paddingRight: 84, marginLeft: -16, marginRight: -84 });
        expect(hero.paddingLeft).toBe(frame.paddingLeft);
        expect(hero.paddingRight).toBe(frame.paddingRight);
        expect(flattenTestStyle(screen.findHostByTestId('pane-hero')!.props.style)).toMatchObject({ paddingLeft: 0, paddingRight: 0 });
    });

    it('does not notify retained area or backdrop consumers when a provider receives equal dimensions', async () => {
        const areaCounter = createRenderCommitCounter();
        const bleedCounter = createRenderCommitCounter();
        const AreaConsumer = React.memo(function AreaConsumer() {
            useRenderCommitCounter(areaCounter);
            const area = useHorizontalSafeArea();
            return <View testID="area" accessibilityValue={{ now: area.right }} />;
        });
        const BleedConsumer = React.memo(function BleedConsumer() {
            useRenderCommitCounter(bleedCounter);
            const bleed = useScreenSafeAreaBleed();
            return <View testID="bleed" accessibilityValue={{ now: bleed.right }} />;
        });
        function Tree(props: Readonly<{ right: number }>) {
            return <HorizontalSafeAreaProvider value={{ left: 16, right: props.right, padded: false }}>
                <AreaConsumer />
                <ScreenSafeAreaFrame presentation={undefined}><BleedConsumer /></ScreenSafeAreaFrame>
            </HorizontalSafeAreaProvider>;
        }
        const screen = await renderScreen(<Tree right={84} />);
        areaCounter.reset();
        bleedCounter.reset();
        await screen.update(<Tree right={84} />);
        expect(areaCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(bleedCounter.read()).toEqual({ renders: 0, commits: 0 });
        await screen.update(<Tree right={42} />);
        expect(screen.findHostByTestId('area')!.props.accessibilityValue.now).toBe(42);
        expect(screen.findHostByTestId('bleed')!.props.accessibilityValue.now).toBe(42);
        expect(areaCounter.read().commits).toBe(1);
        expect(bleedCounter.read().commits).toBe(1);
    });
});
