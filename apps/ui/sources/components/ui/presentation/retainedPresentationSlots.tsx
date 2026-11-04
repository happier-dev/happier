import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Platform, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { resolveFloatingFramePlacementStyle } from '@happier-dev/plugin-ui/presentation';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { PluginSurfaceFocusEligibilityProvider, useLayoutPresentationActive, useRetainedPluginSurfaceFocusNode } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useRetainedDestinationNode } from '@/components/appShell/workspace/DestinationInstanceHost';
export { useLayoutPresentationActive as useRetainedPresentationSlotVisible } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

export type RetainedPresentationRect = Readonly<{ x: number; y: number; width: number; height: number }>;
/**
 * How a slot travels to new geometry on web (a settling floating frame: its settle transition from
 * `resolveFloatingFrameSettleTransition`); absent, it moves at once.
 */
export type RetainedPresentationGeometryTransition = Readonly<{ durationMs: number; easingCss: string; properties: string }>;

/** The same shared position as a native frame; the portal subtracts its settled layout anchor. */
export type RetainedPresentationNativeMotion = Readonly<{
    x: SharedValue<number>;
    y: SharedValue<number>;
    anchorX: number;
    anchorY: number;
    width?: SharedValue<number>;
    height?: SharedValue<number>;
    chromeHeight?: number;
    /** The frame's existing grip stays above an interactive retained picture. */
    overlay?: React.ReactNode;
    onPortalActiveChange?: (active: boolean) => void;
}>;
export const RetainedPresentationNativeMotionContext = React.createContext<RetainedPresentationNativeMotion | null>(null);

/** Route-stable source bodies share one presentation-slot portal across panes and routes. */
export type RetainedPresentationSlotEntry = Readonly<{
    /** Stable per-surface slot id (`presentationSlotId`). */
    slotId: string;
    /** The webview-bearing subtree to keep mounted above the router. */
    node: React.ReactNode;
    /** Last valid placeholder placement; visibility separately parks the retained body. */
    geometry: RetainedPresentationRect | null;
    /** Whether the panel placeholder is currently on-screen (hidden ⇒ kept mounted off-screen). */
    visible: boolean;
    transition?: RetainedPresentationGeometryTransition | null;
    /**
     * The body is only being watched: the pointer passes through all of it to whatever presents it
     * (a floating frame beneath moves and expands by it). Keyboard focus is unaffected.
     */
    inputPassthrough?: boolean;
    nativeMotion?: RetainedPresentationNativeMotion | null;
}>;

export type RetainedPresentationSlotsStore = Readonly<{
    /**
     * Register / update the webview subtree to render in the route-stable portal for a slot. Called on
     * every binder commit so the node + geometry stay fresh; the entry SURVIVES the binder's unmount
     * (that is the keep-alive) and is removed only by `removePortalEntry` or a `closed` lifecycle.
     */
    upsertPortalEntry: (entry: RetainedPresentationSlotEntry) => void;
    /** Preserve the body and last placement, but park it off-screen without a visible binder. */
    parkPortalEntry: (slotId: string) => void;
    /** Explicitly tear down a slot's portal-hosted webview (real close, not a route change). */
    removePortalEntry: (slotId: string, expected?: Readonly<{ node: React.ReactNode }>) => void;
    /** Referentially-stable snapshot of the registered portal entries (for `useSyncExternalStore`). */
    getPortalSnapshot: () => readonly RetainedPresentationSlotEntry[];
    /** Subscribe to portal-registry mutations. */
    subscribePortal: (listener: () => void) => () => void;
}>;

function portalEntriesEqual(
    a: RetainedPresentationSlotEntry,
    b: RetainedPresentationSlotEntry,
): boolean {
    return a.slotId === b.slotId
        && a.node === b.node
        && a.visible === b.visible
        && a.nativeMotion === b.nativeMotion
        && (a.inputPassthrough ?? false) === (b.inputPassthrough ?? false)
        && a.transition?.durationMs === b.transition?.durationMs
        && a.transition?.easingCss === b.transition?.easingCss
        && a.transition?.properties === b.transition?.properties
        && a.geometry?.x === b.geometry?.x
        && a.geometry?.y === b.geometry?.y
        && a.geometry?.width === b.geometry?.width
        && a.geometry?.height === b.geometry?.height;
}

export function createRetainedPresentationSlotsStore(): RetainedPresentationSlotsStore {
    // Portal registry. Insertion-ordered so the overlay paint order is stable; a cached snapshot array
    // keeps `getPortalSnapshot` referentially stable between mutations (required by useSyncExternalStore).
    const portalBySlot = new Map<string, RetainedPresentationSlotEntry>();
    const portalListeners = new Set<() => void>();
    let portalSnapshot: readonly RetainedPresentationSlotEntry[] = [];

    function rebuildPortalSnapshot(): void {
        portalSnapshot = Array.from(portalBySlot.values());
    }
    function notifyPortal(): void {
        for (const listener of [...portalListeners]) listener();
    }

    function removePortalEntry(slotId: string, expected?: Readonly<{ node: React.ReactNode }>): void {
        if (expected && portalBySlot.get(slotId)?.node !== expected.node) return;
        if (!portalBySlot.delete(slotId)) return;
        rebuildPortalSnapshot();
        notifyPortal();
    }

    function parkPortalEntry(slotId: string): void {
        const existing = portalBySlot.get(slotId);
        if (!existing) return;
        const next = {
            ...existing,
            visible: false,
        };
        if (portalEntriesEqual(existing, next)) return;
        portalBySlot.set(slotId, next);
        rebuildPortalSnapshot();
        notifyPortal();
    }

    return {
        upsertPortalEntry(entry) {
            const existing = portalBySlot.get(entry.slotId);
            const rect = entry.geometry;
            // Responsive binders can hand off before the replacement has been measured.
            // Visibility still parks a retired route; only valid placement replaces placement.
            const placed = rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)
                && Number.isFinite(rect.width) && Number.isFinite(rect.height)
                && rect.width > 0 && rect.height > 0;
            if (!placed && existing?.geometry) entry = { ...entry, geometry: existing.geometry };
            if (existing && portalEntriesEqual(existing, entry)) {
                return;
            }
            portalBySlot.set(entry.slotId, entry);
            rebuildPortalSnapshot();
            notifyPortal();
        },
        parkPortalEntry,
        removePortalEntry,
        getPortalSnapshot() {
            return portalSnapshot;
        },
        subscribePortal(listener) {
            portalListeners.add(listener);
            return () => {
                portalListeners.delete(listener);
            };
        },
    };
}

const RetainedPresentationSlotsContext = React.createContext<RetainedPresentationSlotsStore | null>(null);

const portalStyles = StyleSheet.create(() => ({
    // The overlay container fills the app and never intercepts touches itself — only the positioned
    // webview slots are interactive (`box-none`).
    overlay: {
        ...StyleSheet.absoluteFillObject,
    },
}));

/**
 * Route-stable portal host. Renders every registered webview subtree ONCE, above the route Stack,
 * each positioned over its panel placeholder by the slot geometry. Because this host is mounted in the
 * provider (outside the router), the webview React instance survives panel unmount/remount — a route
 * change repositions the overlay instead of reloading the page.
 */
export function RetainedPresentationPortalHost(): React.ReactElement | null {
    const store = React.useContext(RetainedPresentationSlotsContext);
    const subscribe = React.useCallback(
        (listener: () => void) => (store ? store.subscribePortal(listener) : () => {}),
        [store],
    );
    const getSnapshot = React.useCallback(
        (): readonly RetainedPresentationSlotEntry[] => (store ? store.getPortalSnapshot() : EMPTY_PORTAL_ENTRIES),
        [store],
    );
    const entries = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (entries.length === 0) {
        return null;
    }
    return (
        <View testID="browser-presentation-portal-host" style={portalStyles.overlay} pointerEvents="box-none">
            {entries.map((entry) => (
                <RetainedPresentationPortalSlot
                    key={entry.slotId}
                    entry={entry}
                />
            ))}
        </View>
    );
}

function RetainedPresentationPortalSlot({ entry }: Readonly<{ entry: RetainedPresentationSlotEntry }>) {
    const motion = entry.nativeMotion;
    // Keep React overlay elements and JS custody callbacks out of animated worklet closures.
    const x = motion?.x;
    const y = motion?.y;
    const width = motion?.width;
    const height = motion?.height;
    const anchorX = motion?.anchorX ?? 0;
    const anchorY = motion?.anchorY ?? 0;
    const chromeHeight = motion?.chromeHeight ?? 0;
    const body = <PluginSurfaceFocusEligibilityProvider active={entry.visible}>
        {entry.node}
    </PluginSurfaceFocusEligibilityProvider>;
    const animatedStyle = useAnimatedStyle(() => ({
        ...(width && height ? {
            width: width.value,
            height: Math.max(0, height.value - chromeHeight),
        } : {}),
        transform: [
            { translateX: x ? x.value - anchorX : 0 },
            { translateY: y ? y.value - anchorY : 0 },
        ],
    }));
    return <Animated.View
        testID={`browser-presentation-portal-slot-${entry.slotId}`}
        style={Platform.OS === 'web' ? resolvePortalSlotStyle(entry) : [resolvePortalSlotStyle(entry), animatedStyle]}
        pointerEvents={entry.visible && motion?.overlay ? 'box-none' : entry.visible && !entry.inputPassthrough ? 'auto' : 'none'}
    >
        {Platform.OS === 'web' ? body : <View style={{ flex: 1 }}
            pointerEvents={entry.visible && !entry.inputPassthrough ? 'auto' : 'none'}>{body}</View>}
        {entry.visible ? motion?.overlay : null}
    </Animated.View>;
}

const EMPTY_PORTAL_ENTRIES: readonly RetainedPresentationSlotEntry[] = [];

/**
 * Position a portal slot over its panel placeholder. A hidden slot (route changed away, or no measured
 * geometry yet) is kept MOUNTED but parked off-screen so its native/DOM webview is preserved without
 * painting over the active route.
 */
function resolvePortalSlotStyle(entry: RetainedPresentationSlotEntry): ViewStyle {
    const rect = entry.geometry;
    if (!entry.visible || !rect || rect.width <= 0 || rect.height <= 0) {
        return { position: 'absolute', left: -100000, top: 0, width: 1, height: 1, opacity: 0 };
    }
    return {
        // The frame owner's placement: on web a transform, so the slot and a settling frame travel
        // on the compositor together; native keeps its offsets under the shared native motion.
        ...resolveFloatingFramePlacementStyle(rect),
        // A settling frame and the body it presents travel on the same curve (web only).
        ...(entry.transition && Platform.OS === 'web' ? {
            transitionProperty: entry.transition.properties,
            transitionDuration: `${entry.transition.durationMs}ms`,
            transitionTimingFunction: entry.transition.easingCss,
        } : {}),
    };
}

/**
 * Route-stable retention + portal provider. Mount once OUTSIDE the route stack (the app root layout)
 * so a single store + portal host survive every route/panel mount-unmount cycle.
 */
export function RetainedPresentationSlotsProvider(
    props: React.PropsWithChildren<{ store?: RetainedPresentationSlotsStore }>,
): React.ReactElement {
    const storeRef = React.useRef<RetainedPresentationSlotsStore | null>(null);
    if (storeRef.current === null) {
        storeRef.current = props.store ?? createRetainedPresentationSlotsStore();
    }
    return (
        <RetainedPresentationSlotsContext.Provider value={storeRef.current}>
            {props.children}
            <RetainedPresentationPortalHost />
        </RetainedPresentationSlotsContext.Provider>
    );
}

/**
 * Read the route-stable retention store. Returns `null` when no provider is mounted (e.g. isolated
 * tests / surfaces not yet under the provider); callers fall back to component-local retention so
 * behavior is unchanged in that case.
 */
export function useOptionalRetainedPresentationSlotsStore(): RetainedPresentationSlotsStore | null {
    return React.useContext(RetainedPresentationSlotsContext);
}

export type UseRetainedPresentationSlotInput = Readonly<{
    slotId: string;
    node: React.ReactNode;
    geometry?: RetainedPresentationRect | null;
    visible?: boolean;
    transition?: RetainedPresentationGeometryTransition | null;
    inputPassthrough?: boolean;
    nativeMotion?: RetainedPresentationNativeMotion | null;
    /**
     * When `true`, this binder is the active host for the slot and registers its `node` into the
     * route-stable portal. When `false` (no provider, or the caller opted out), nothing is registered
     * and the caller renders the `node` inline itself.
     */
    enabled?: boolean;
}>;

export type UseRetainedPresentationSlotResult = Readonly<{
    /** Whether the webview is being hosted by the route-stable portal (vs. rendered inline). */
    portalActive: boolean;
}>;

/**
 * Bind a slot's webview subtree into the route-stable portal. The binder calls this on every commit
 * so the `node` + geometry stay fresh; crucially it does NOT remove the entry when the binder
 * unmounts — that retention is what preserves the webview across a route change. Unmount parks the
 * entry off-screen/non-interactive; the entry is removed only by an explicit `close` (via the store)
 * or a `closed` lifecycle. When no provider is mounted (or `enabled` is false) the hook is inert and
 * `portalActive` is false, so the caller renders inline and behavior is unchanged.
 */
export function useRetainedPresentationSlot(
    input: UseRetainedPresentationSlotInput,
): UseRetainedPresentationSlotResult {
    const store = React.useContext(RetainedPresentationSlotsContext);
    const enabled = (input.enabled ?? true) && store !== null;
    const layoutActive = useLayoutPresentationActive();
    const visible = layoutActive && (input.visible ?? true);

    React.useLayoutEffect(() => {
        if (!enabled || !store) return;
        store.upsertPortalEntry({
            slotId: input.slotId,
            node: input.node,
            geometry: input.geometry ?? null,
            visible,
            transition: input.transition ?? null,
            inputPassthrough: input.inputPassthrough ?? false,
            nativeMotion: input.nativeMotion ?? null,
        });
    });

    React.useLayoutEffect(() => {
        if (!enabled || !store) return undefined;
        return () => {
            // Do not remove the entry: keep the webview mounted, but make it non-interactive while no
            // route/panel binder owns its visible geometry.
            store.parkPortalEntry(input.slotId);
        };
    }, [enabled, input.slotId, store]);

    return { portalActive: enabled };
}

function rectsEqual(a: RetainedPresentationRect | null, b: RetainedPresentationRect | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export type RetainedPresentationSlotBinderProps = Readonly<{
    /** Stable per-surface slot id (`presentationSlotId`). */
    slotId: string;
    /** Whether this surface is currently on-screen (hidden ⇒ kept mounted off-screen in the portal). */
    visible?: boolean;
    /**
     * Opt-in. When `true` (and a provider is mounted), the `children` are hosted by the route-stable
     * portal and this binder renders only a measuring placeholder. When `false` / no provider, the
     * `children` render inline (current behavior) — so adopting this is a no-op until a surface flips it
     * on for the desktop/streamed webview path.
     */
    enabled?: boolean;
    /**
     * The presentation already knows where the body stands in window space (a floating frame moves
     * by position, which a layout observer does not report). Supplied, it replaces measurement.
     */
    windowGeometry?: RetainedPresentationRect | null;
    transition?: RetainedPresentationGeometryTransition | null;
    /** See `RetainedPresentationSlotEntry.inputPassthrough`. */
    inputPassthrough?: boolean;
    children: React.ReactNode;
}>;

/**
 * Host a surface's webview subtree in the route-stable portal, keyed by `slotId`. The binder measures
 * its placeholder in WINDOW coordinates (the portal overlay is window-absolute) and feeds that geometry
 * to the portal so the hosted webview paints over the placeholder. Because the portal lives above the
 * router, the webview instance survives this binder's unmount on a route change.
 *
 * When `enabled` is false or no provider is mounted, the children render inline unchanged.
 */
export function RetainedPresentationSlotBinder(props: RetainedPresentationSlotBinderProps): React.ReactElement {
    const nativeMotion = React.useContext(RetainedPresentationNativeMotionContext);
    const placeholderRef = React.useRef<View | null>(null);
    const [geometry, setGeometry] = React.useState<RetainedPresentationRect | null>(null);
    const updateGeometry = React.useCallback((next: RetainedPresentationRect | null) => {
        setGeometry((prev) => (rectsEqual(prev, next) ? prev : next));
    }, []);
    const measure = React.useCallback(() => {
        const node = placeholderRef.current;
        if (!node || typeof node.measureInWindow !== 'function') return;
        node.measureInWindow((x, y, width, height) => {
            if (!Number.isFinite(width) || !Number.isFinite(height)) return;
            updateGeometry({ x, y, width, height });
        });
    }, [updateGeometry]);
    const onLayout = React.useCallback((_event: LayoutChangeEvent) => {
        // `onLayout` x/y are parent-relative; re-measure in window coordinates for the absolute overlay.
        measure();
    }, [measure]);
    const retainedDestination = useRetainedDestinationNode(props.children);
    const retainedFocus = useRetainedPluginSurfaceFocusNode(retainedDestination);
    // Placement echoes must not mint a new content tree and notify the portal's subscribers.
    // Captured scope and actual child changes still replace their respective wrappers.
    const focusEligibleChildren = React.useMemo(() => (
        <PluginSurfaceFocusEligibilityProvider active={props.visible ?? true}>
            {retainedFocus}
        </PluginSurfaceFocusEligibilityProvider>
    ), [props.visible, retainedFocus]);

    const { portalActive } = useRetainedPresentationSlot({
        slotId: props.slotId,
        node: focusEligibleChildren,
        geometry: props.windowGeometry !== undefined ? props.windowGeometry : geometry,
        visible: props.visible ?? true,
        enabled: props.enabled,
        transition: props.transition,
        inputPassthrough: props.inputPassthrough,
        nativeMotion,
    });
    const onPortalActiveChange = nativeMotion?.onPortalActiveChange;
    React.useEffect(() => {
        if (!portalActive || !onPortalActiveChange) return;
        onPortalActiveChange(true);
        return () => onPortalActiveChange(false);
    }, [portalActive, onPortalActiveChange]);

    if (!portalActive) {
        return <>{focusEligibleChildren}</>;
    }
    return (
        <View
            ref={placeholderRef}
            testID={`browser-keepalive-placeholder-${props.slotId}`}
            style={keepAliveStyles.placeholder}
            onLayout={onLayout}
        />
    );
}

const keepAliveStyles = StyleSheet.create(() => ({
    placeholder: {
        flex: 1,
    },
}));
