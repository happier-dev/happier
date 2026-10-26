import * as React from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

import {
    resolveHorizontalSafeAreaRoot,
    resolveNavigatorBleed,
    resolveScreenFrameInsets,
    type HorizontalEdges,
    type HorizontalSafeArea,
} from './horizontalSafeArea';

// No provider means no side insets to own (isolated renders, tests).
const HorizontalSafeAreaContext = React.createContext<HorizontalSafeArea>({ left: 0, right: 0, padded: true });

type ScreenBackdropRegistrar = (color: string) => () => void;
type ScreenBackdrop = Readonly<{ register: ScreenBackdropRegistrar; padding: HorizontalEdges }>;
const ScreenBackdropContext = React.createContext<ScreenBackdrop | null>(null);
const NO_BLEED: HorizontalEdges = { left: 0, right: 0 };

function useStableArea(area: HorizontalSafeArea): HorizontalSafeArea {
    const { left, right, padded } = area;
    return React.useMemo(() => ({ left, right, padded }), [left, padded, right]);
}

export function useHorizontalSafeArea(): HorizontalSafeArea {
    return React.useContext(HorizontalSafeAreaContext);
}

/** Chrome rendered by a navigator outside its screens (custom stack headers) keeps its content safe. */
export function useHorizontalSafeAreaContentPadding(): Readonly<{ paddingLeft: number; paddingRight: number }> {
    const area = useHorizontalSafeArea();
    return React.useMemo(() => (
        area.padded ? { paddingLeft: 0, paddingRight: 0 } : { paddingLeft: area.left, paddingRight: area.right }
    ), [area.left, area.padded, area.right]);
}

export function HorizontalSafeAreaProvider(props: Readonly<{ value: HorizontalSafeArea; children: React.ReactNode }>) {
    const value = useStableArea(props.value);
    return <HorizontalSafeAreaContext.Provider value={value}>{props.children}</HorizontalSafeAreaContext.Provider>;
}

/** App root: every surface starts inside the horizontal safe area. */
export function HorizontalSafeAreaRoot(props: Readonly<{ children: React.ReactNode }>) {
    const insets = useSafeAreaInsets();
    const root = resolveHorizontalSafeAreaRoot(insets);
    return (
        <View style={{ flex: 1, paddingLeft: root.padding.left, paddingRight: root.padding.right }}>
            <HorizontalSafeAreaProvider value={root.child}>{props.children}</HorizontalSafeAreaProvider>
        </View>
    );
}

/** Wraps a stack navigator so its native or custom headers and screen backgrounds reach the window edge. */
export function NavigatorSafeAreaBleed(props: Readonly<{ children: React.ReactNode }>) {
    const bleed = resolveNavigatorBleed(useHorizontalSafeArea());
    return (
        <View style={{ flex: 1, minWidth: 0, minHeight: 0, marginLeft: bleed.margin.left, marginRight: bleed.margin.right }}>
            <HorizontalSafeAreaProvider value={bleed.child}>{props.children}</HorizontalSafeAreaProvider>
        </View>
    );
}

const PRESENTED_OUTSIDE_NAVIGATOR_ON_IOS: ReadonlySet<NonNullable<NativeStackNavigationOptions['presentation']>> = new Set([
    'modal',
    'transparentModal',
    'fullScreenModal',
    'formSheet',
    'pageSheet',
]);

function isPresentedOutsideNavigator(presentation: NativeStackNavigationOptions['presentation']): boolean {
    // iOS presents these in their own view controller, sized by UIKit rather than by the stack's view.
    return Platform.OS === 'ios' && presentation != null && PRESENTED_OUTSIDE_NAVIGATOR_ON_IOS.has(presentation);
}

/**
 * One navigator screen. Pads its content inside the edges its navigator reclaimed and paints that
 * margin with the screen's own backdrop: the stack's `contentStyle` background by default, or the
 * color a full-screen backdrop owner declares with `useScreenSafeAreaBackdrop`.
 */
export function ScreenSafeAreaFrame(props: Readonly<{
    presentation: NativeStackNavigationOptions['presentation'];
    children: React.ReactNode;
}>) {
    const frame = resolveScreenFrameInsets(useHorizontalSafeArea(), {
        presentedOutsideNavigator: isPresentedOutsideNavigator(props.presentation),
    });
    const [backdropColor, setBackdropColor] = React.useState<string | null>(null);
    const registrationsRef = React.useRef<Array<{ color: string }>>([]);
    const register = React.useCallback<ScreenBackdropRegistrar>((color) => {
        const entry = { color };
        registrationsRef.current.push(entry);
        setBackdropColor(color);
        return () => {
            registrationsRef.current = registrationsRef.current.filter((candidate) => candidate !== entry);
            const latest = registrationsRef.current[registrationsRef.current.length - 1];
            setBackdropColor(latest ? latest.color : null);
        };
    }, []);
    const hasPadding = frame.padding.left > 0 || frame.padding.right > 0;
    const { left: paddingLeft, right: paddingRight } = frame.padding;
    const backdrop = React.useMemo<ScreenBackdrop>(
        () => ({ register, padding: { left: paddingLeft, right: paddingRight } }),
        [paddingLeft, paddingRight, register],
    );

    return (
        <View
            style={{
                flex: 1,
                paddingLeft: frame.padding.left,
                paddingRight: frame.padding.right,
                backgroundColor: hasPadding && backdropColor ? backdropColor : undefined,
            }}
        >
            <HorizontalSafeAreaProvider value={frame.child}>
                <ScreenBackdropContext.Provider value={backdrop}>{props.children}</ScreenBackdropContext.Provider>
            </HorizontalSafeAreaProvider>
        </View>
    );
}

/**
 * Declares the backdrop color of a full-screen surface so its screen frame extends it under the side
 * insets. Only the outermost declaration in a screen counts: render `ScreenBackdropBoundary` around
 * nested surfaces (side panes, nested lists) that do not own the screen backdrop.
 */
export function useScreenSafeAreaBackdrop(color: string): void {
    const register = React.useContext(ScreenBackdropContext)?.register;
    React.useLayoutEffect(() => (register ? register(color) : undefined), [color, register]);
}

/**
 * For a full-screen surface that should itself reach the window edge (a screen-level scroll view, a
 * decorative hero): the margin its screen frame applied, to cancel with a negative margin while
 * padding its own content by the same amount. Zero outside a frame and behind `ScreenBackdropBoundary`.
 */
export function useScreenSafeAreaBleed(): HorizontalEdges {
    return React.useContext(ScreenBackdropContext)?.padding ?? NO_BLEED;
}

export function ScreenBackdropBoundary(props: Readonly<{ children: React.ReactNode }>) {
    return <ScreenBackdropContext.Provider value={null}>{props.children}</ScreenBackdropContext.Provider>;
}
