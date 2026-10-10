import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, {
    Easing,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { CardGrid, CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { resolveInPlaceMorphTiming, type InPlaceMorphTiming } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

export type SetupBlockItem = Readonly<{
    id: string;
    /** Columns the tile takes: two, or the whole row (a phone's single column either way). */
    span?: 2 | 'row';
    /** The tile at rest. Calling `open` grows it into its panel. */
    renderTile: (controls: Readonly<{ open: () => void }>) => React.ReactNode;
    /**
     * What the tile grows into. It is mounted only while open (and while it collapses), so work it
     * starts — a pairing invite, the camera — lives exactly as long as the panel is on screen.
     */
    renderPanel?: (controls: Readonly<{ close: () => void }>) => React.ReactNode;
}>;

const PanelWidthContext = React.createContext<number | null>(null);

/**
 * The width an open panel is laid out at (the row's), before the panel has measured itself: a panel
 * that picks its composition by width (side by side vs stacked) starts with the right one, so the row's
 * height does not jump mid-growth. Null outside a panel.
 */
export function useSetupBlockPanelWidth(): number | null {
    return React.useContext(PanelWidthContext);
}

type Geometry = Readonly<{ x: number; y: number; w: number; h: number }>;
type Sizes = Readonly<{ width: number; restHeight: number; panelHeight: number }>;
/**
 * Where each opacity track sits on the fade clock (0..1 over the fade's duration): covered tiles are
 * gone at `coveredEnd`, the origin tile hands over to the frame by `handoverEnd`, the content starts
 * at `contentStart`.
 */
type Tracks = Readonly<{ coveredEnd: number; handoverEnd: number; contentStart: number }>;
type Phase = 'open' | 'closing';

function resolveTracks(timing: InPlaceMorphTiming): Tracks {
    const clock = timing.clockMs;
    if (timing.frameMs === 0) return { coveredEnd: 1, handoverEnd: 1, contentStart: 0 };
    return {
        coveredEnd: timing.coveredFadeMs / clock,
        handoverEnd: timing.contentDelayMs / clock,
        contentStart: timing.contentDelayMs / clock,
    };
}

function clamp01(value: number): number {
    'worklet';
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function lerp(from: number, to: number, progress: number): number {
    'worklet';
    return from + (to - from) * progress;
}

const FRAME_EASING = reanimatedMotionTokens.easing.standard;
const CLOCK_EASING = Easing.linear;

/**
 * A row of set-up blocks, each of which can grow in place into what it offers (the signature moment of
 * Home's Get set up, lab I4; also Connected services' "Connect a service"). The frame grows from the
 * pressed block's box to the row's full width (size + position), the other blocks fade out beneath it
 * and keep their slots, the content cross-fades in after the frame has started, and only the row's
 * height eases from the blocks' height to the panel's; nothing above moves. The panel's `close` or Esc
 * runs it backwards. Reduced motion swaps at once with a cross-fade. Blocks sit on the card grid
 * (`CardGrid`); a block may span two columns or the whole row.
 *
 * Opacity and position animate on the compositor. The frame's width and height are layout
 * properties, but only of this one absolutely positioned box whose content is laid out once at the
 * final width, so nothing else reflows while it grows; the row's height is the one intended reflow.
 */
export const SetupBlockGrid = React.memo(function SetupBlockGrid(props: Readonly<{
    items: readonly SetupBlockItem[];
    /** At most this many columns (a phone passes one). */
    columns?: 1 | 2 | 3;
    /**
     * The block its host wants open (null: none). Given, the host decides: a press or a close is
     * reported to `onOpenChange` and the grid follows `openId` (a page opening a block on request, a
     * catalog nested in a panel). A block named at mount is already open, without growing.
     */
    openId?: string | null;
    onOpenChange?: (id: string | null) => void;
    /** `bare`: the frame draws no paper of its own (a grid nested in a panel that already has one). */
    frame?: 'paper' | 'bare';
    testID: string;
}>) {
    const reducedMotion = useReducedMotionPreference();
    const controlled = props.openId !== undefined;
    const startOpenId = controlled ? props.openId ?? null : null;
    const [open, setOpen] = React.useState<Readonly<{ id: string; phase: Phase }> | null>(
        () => (startOpenId ? { id: startOpenId, phase: 'open' } : null),
    );
    const [contentWidth, setContentWidth] = React.useState<number | null>(null);
    const containerRef = React.useRef<View>(null);
    const slotRefs = React.useRef(new Map<string, View>());

    const frame = useSharedValue(startOpenId ? 1 : 0);
    const clock = useSharedValue(startOpenId ? 1 : 0);
    const origin = useSharedValue<Geometry>({ x: 0, y: 0, w: 0, h: 0 });
    const sizes = useSharedValue<Sizes>({ width: 0, restHeight: 0, panelHeight: 0 });
    const tracks = useSharedValue<Tracks>(resolveTracks(resolveInPlaceMorphTiming(false)));
    const pinned = useSharedValue(startOpenId ? 1 : 0);
    const onOpenChangeRef = React.useRef(props.onOpenChange);
    onOpenChangeRef.current = props.onOpenChange;

    const openRef = React.useRef(open);
    openRef.current = open;

    const finishClose = React.useCallback(() => {
        pinned.value = 0;
        frame.value = 0;
        clock.value = 0;
        setOpen(null);
    }, [clock, frame, pinned]);
    const reportOpen = React.useCallback((id: string | null) => {
        onOpenChangeRef.current?.(id);
    }, []);

    const begin = React.useCallback((id: string, geometry: Geometry | null) => {
        const timing = resolveInPlaceMorphTiming(reducedMotion);
        const current = sizes.value;
        origin.value = geometry ?? { x: 0, y: 0, w: current.width, h: current.restHeight };
        tracks.value = resolveTracks(timing);
        pinned.value = 1;
        setOpen({ id, phase: 'open' });
        frame.value = timing.frameMs === 0 ? 1 : withTiming(1, { duration: timing.frameMs, easing: FRAME_EASING });
        clock.value = withTiming(1, { duration: timing.clockMs, easing: CLOCK_EASING });
    }, [clock, frame, origin, pinned, reducedMotion, sizes, tracks]);

    const runOpen = React.useCallback((id: string) => {
        if (openRef.current) return;
        const slot = slotRefs.current.get(id);
        const container = containerRef.current;
        const measurable = slot as (View & { measureLayout?: View['measureLayout'] }) | undefined;
        if (!measurable || !container || typeof measurable.measureLayout !== 'function') {
            begin(id, null);
            return;
        }
        measurable.measureLayout(
            container as never,
            (x, y, w, h) => begin(id, { x, y, w, h }),
            () => begin(id, null),
        );
    }, [begin]);

    const runClose = React.useCallback(() => {
        const current = openRef.current;
        if (!current || current.phase === 'closing') return;
        const timing = resolveInPlaceMorphTiming(reducedMotion);
        setOpen({ id: current.id, phase: 'closing' });
        // Reduced motion keeps the panel's full frame while it fades, then swaps back at once.
        if (timing.frameMs > 0) frame.value = withTiming(0, { duration: timing.frameMs, easing: FRAME_EASING });
        clock.value = withTiming(0, { duration: timing.clockMs, easing: CLOCK_EASING }, (finished) => {
            'worklet';
            if (finished) runOnJS(finishClose)();
        });
    }, [clock, finishClose, frame, reducedMotion]);

    // What a press and a close do: act at once, or ask the host (which answers through `openId`).
    const openItem = React.useCallback((id: string) => {
        if (openRef.current) return;
        if (controlled) reportOpen(id);
        else {
            runOpen(id);
            reportOpen(id);
        }
    }, [controlled, reportOpen, runOpen]);
    const close = React.useCallback(() => {
        const current = openRef.current;
        if (!current || current.phase === 'closing') return;
        if (controlled) reportOpen(null);
        else {
            runClose();
            reportOpen(null);
        }
    }, [controlled, reportOpen, runClose]);

    // A host that decides follows through here: a newly named block grows from its slot, null runs
    // backwards, and a different block while one is open takes its place at once.
    const requestedId = controlled ? props.openId ?? null : undefined;
    React.useEffect(() => {
        if (requestedId === undefined) return;
        const current = openRef.current;
        if (requestedId === null) {
            if (current && current.phase === 'open') runClose();
            return;
        }
        if (!current) runOpen(requestedId);
        else if (current.id !== requestedId || current.phase === 'closing') {
            setOpen({ id: requestedId, phase: 'open' });
            pinned.value = 1;
            frame.value = 1;
            clock.value = 1;
        }
    }, [clock, frame, pinned, requestedId, runClose, runOpen]);

    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.overlay,
        enabled: open?.phase === 'open',
        onEscape: () => {
            close();
            return true;
        },
    });

    const onContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (!Number.isFinite(width) || width <= 0) return;
        sizes.value = { ...sizes.value, width };
        setContentWidth((current) => (current === width ? current : width));
    }, [sizes]);
    const onGridLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        if (!Number.isFinite(height) || height <= 0) return;
        sizes.value = { ...sizes.value, restHeight: height };
    }, [sizes]);
    const onPanelLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        if (!Number.isFinite(height) || height <= 0) return;
        sizes.value = { ...sizes.value, panelHeight: height };
    }, [sizes]);

    // Only the row's height reflows, easing from the tiles' height to the panel's; at rest it is
    // the grid's own height ('auto' keeps the same style key, which the native updater needs).
    const containerStyle = useAnimatedStyle(() => {
        const current = sizes.value;
        if (pinned.value === 0 || current.restHeight <= 0) return { height: 'auto' as const };
        const target = current.panelHeight > 0 ? current.panelHeight : current.restHeight;
        return { height: lerp(current.restHeight, target, frame.value) };
    });

    const openItemDef = open ? props.items.find((item) => item.id === open.id) ?? null : null;
    const panel = openItemDef?.renderPanel?.({ close }) ?? null;
    // The open item left the list (dismissed or done elsewhere): nothing is left to cover the row.
    const orphaned = open !== null && panel === null;
    React.useEffect(() => {
        if (!orphaned) return;
        finishClose();
        if (controlled) reportOpen(null);
    }, [controlled, finishClose, orphaned, reportOpen]);

    return (
        <Animated.View
            ref={containerRef as never}
            testID={props.testID}
            onLayout={onContainerLayout}
            style={[styles.container, open ? styles.containerCovered : null, containerStyle]}
        >
            <View onLayout={onGridLayout}>
                <CardGrid columns={props.columns}>
                    {props.items.map((item) => (
                        <CardGridCell key={item.id} span={item.span}>
                            <MorphSlot
                                testID={`${props.testID}.slot.${item.id}`}
                                role={open === null ? 'rest' : open.id === item.id ? 'origin' : 'covered'}
                                clock={clock}
                                tracks={tracks}
                                slotRef={(node) => {
                                    if (node) slotRefs.current.set(item.id, node);
                                    else slotRefs.current.delete(item.id);
                                }}
                            >
                                {item.renderTile({ open: () => openItem(item.id) })}
                            </MorphSlot>
                        </CardGridCell>
                    ))}
                </CardGrid>
            </View>
            {open && panel ? (
                <MorphFrame
                    testID={`${props.testID}.panel`}
                    frame={frame}
                    clock={clock}
                    origin={origin}
                    sizes={sizes}
                    tracks={tracks}
                    bare={props.frame === 'bare'}
                    contentWidth={contentWidth}
                    onContentLayout={onPanelLayout}
                >
                    {panel}
                </MorphFrame>
            ) : null}
        </Animated.View>
    );
});

/**
 * One tile's place in the grid. While a panel is open the tile keeps its slot: the origin hands over
 * to the growing frame and the others fade out beneath it, leaving the accessibility tree.
 */
function MorphSlot(props: Readonly<{
    testID: string;
    role: 'rest' | 'origin' | 'covered';
    clock: SharedValue<number>;
    tracks: SharedValue<Tracks>;
    slotRef: (node: View | null) => void;
    children: React.ReactNode;
}>) {
    const { role, clock, tracks } = props;
    const animatedStyle = useAnimatedStyle(() => {
        if (role === 'rest') return { opacity: 1 };
        const end = role === 'origin' ? tracks.value.handoverEnd : tracks.value.coveredEnd;
        return { opacity: end <= 0 ? 0 : 1 - clamp01(clock.value / end) };
    }, [role]);
    const hidden = role !== 'rest';
    return (
        <Animated.View
            ref={props.slotRef as never}
            testID={props.testID}
            style={[styles.slot, animatedStyle]}
            pointerEvents={hidden ? 'none' : 'auto'}
            accessibilityElementsHidden={hidden}
            importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
            aria-hidden={hidden || undefined}
        >
            {props.children}
        </Animated.View>
    );
}

/** The growing frame: the panel's surface, with the panel laid out once at the row's full width. */
function MorphFrame(props: Readonly<{
    testID: string;
    frame: SharedValue<number>;
    clock: SharedValue<number>;
    origin: SharedValue<Geometry>;
    sizes: SharedValue<Sizes>;
    tracks: SharedValue<Tracks>;
    bare: boolean;
    contentWidth: number | null;
    onContentLayout: (event: LayoutChangeEvent) => void;
    children: React.ReactNode;
}>) {
    const { frame, clock, origin, sizes, tracks } = props;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const frameStyle = useAnimatedStyle(() => {
        const from = origin.value;
        const current = sizes.value;
        const progress = frame.value;
        const fullWidth = current.width > 0 ? current.width : from.w;
        const fullHeight = current.panelHeight > 0 ? current.panelHeight : Math.max(from.h, current.restHeight);
        const handover = tracks.value.handoverEnd;
        return {
            width: lerp(from.w, fullWidth, progress),
            height: lerp(from.h, fullHeight, progress),
            opacity: handover <= 0 ? clamp01(clock.value) : clamp01(clock.value / handover),
            transform: [
                { translateX: lerp(from.x, 0, progress) },
                { translateY: lerp(from.y, 0, progress) },
            ],
        };
    });
    const contentStyle = useAnimatedStyle(() => {
        const start = tracks.value.contentStart;
        return { opacity: start >= 1 ? 0 : clamp01((clock.value - start) / (1 - start)) };
    });
    return (
        <Animated.View testID={props.testID} style={[styles.frame, props.bare ? styles.frameBare : null, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }, frameStyle]}>
            <Animated.View
                onLayout={props.onContentLayout}
                style={[styles.frameContent, props.contentWidth !== null ? { width: props.contentWidth } : styles.frameContentFill, contentStyle]}
            >
                <PanelWidthContext.Provider value={props.contentWidth}>{props.children}</PanelWidthContext.Provider>
            </Animated.View>
        </Animated.View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    // While a panel covers the row, the row clips what it covers as its height eases.
    containerCovered: {
        overflow: 'hidden',
    },
    slot: {
        flex: 1,
    },
    frame: {
        position: 'absolute',
        left: 0,
        top: 0,
        overflow: 'hidden',
        borderRadius: PAGE_LIST_METRICS.sheetRadiusPx,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    frameBare: {
        borderWidth: 0,
        borderRadius: 0,
    },
    frameContent: {
        position: 'absolute',
        left: 0,
        top: 0,
    },
    frameContentFill: {
        right: 0,
    },
}));
