import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Platform, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { resolveFloatingFramePlacementStyle } from '@happier-dev/plugin-ui/presentation';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { PluginSurfaceFocusEligibilityProvider, useLayoutPresentationActive, useRetainedPluginSurfaceFocusNode } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useRetainedCurrentUiContextNode } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useRetainedDestinationNode } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useRetainedDetailsTabNode } from '@/components/appShell/panes/details/workspace/detailsTabLifetime';
import { RightSidebarActionsContext } from '@/components/appShell/rightSidebar/rightSidebarActions';
import { SessionCockpitBottomChromeHeightContext, useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { RetainedPresentationEntryLifetime } from './retainedPresentationEntryLifetime';
import { intersectRetainedPresentationRects, observeWebRetainedPresentationLayout, readWebRetainedPresentationGeometry } from './retainedPresentationGeometry';
import { requireReactDOM } from '@/utils/web/reactDomCjs';
import { RetainedPresentationSlotGeometryProvider } from './retainedPresentationSlotGeometry';
import { resolvePaneUnderlayAccessibilityProps } from '@/components/ui/panels/ModalPaneBoundary';
export { useLayoutPresentationActive as useRetainedPresentationSlotVisible } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

export type RetainedPresentationRect = Readonly<{ x: number; y: number; width: number; height: number }>;
/** A scroll owner supplies its existing native viewport, without adding another measuring view. */
export const RetainedPresentationViewportContext = React.createContext<Readonly<{
    measure: (publish: (rect: RetainedPresentationRect | null) => void) => void;
}> | null>(null);
/** Geometry only: this does not redirect unrelated browser sources into a Session's store. */
export const RetainedPresentationGeometryRefreshContext = React.createContext<(() => void) | null>(null);

/**
 * The app's floating layer: a presentation that floats over the whole app (the Session viewer's frame)
 * renders its chrome here, above every page and the in-flow bodies this portal hosts, beneath the
 * retained bodies it presents itself, and below popovers, dialogs and notices (app-level layers).
 * The retained body never moves into the layer: it stays in its owner's tree, under the Session and
 * Account providers that reach it there (`useRetainedPresentationFloatingBody`).
 */
export type RetainedPresentationFloatingLayer = Readonly<{
    /**
     * Renders `node` into the layer. Web portals it with React DOM, keeping its React context; native
     * has no such portal and draws it at the app root, so the presenter re-provides the context its
     * chrome reads.
     */
    present: (node: React.ReactNode) => React.ReactNode;
    /** The layer's rect in window space. */
    measure: () => RetainedPresentationRect | null;
}>;
export const RetainedPresentationFloatingLayerContext = React.createContext<RetainedPresentationFloatingLayer | null>(null);
/** True under the floating layer: a body bound there paints above in-flow bodies and the floating chrome. */
const RetainedPresentationFloatingContext = React.createContext(false);
/** Stacking inside the portal overlay: in-flow bodies, then floating chrome, then the bodies it presents. */
const FLOATING_LAYER_Z_INDEX = 1;
const FLOATING_BODY_Z_INDEX = 2;
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
/** A frame drawn apart from its body (the floating layer) hands its motion to the body here. */
const RetainedPresentationNativeMotionPublisherContext = React.createContext<((motion: RetainedPresentationNativeMotion | null) => void) | null>(null);

/** A native frame's motion, for the body it presents from another tree (see `useRetainedPresentationFloatingBody`). */
export function usePublishRetainedPresentationNativeMotion(motion: RetainedPresentationNativeMotion | null): void {
    const publish = React.useContext(RetainedPresentationNativeMotionPublisherContext);
    React.useLayoutEffect(() => { publish?.(motion); }, [motion, publish]);
    React.useLayoutEffect(() => (publish ? () => publish(null) : undefined), [publish]);
}

export type RetainedPresentationFloatingBody = Readonly<{
    /** Wraps the chrome that draws the frame, wherever it is drawn (the floating layer, or in place). */
    frame: (node: React.ReactNode) => React.ReactElement;
    /**
     * Wraps the retained body, which stays in its owner's tree: it binds above the floating chrome and
     * moves with the frame's native motion.
     */
    body: (node: React.ReactNode) => React.ReactElement;
}>;

type NativeMotionChannel = Readonly<{
    publish: (motion: RetainedPresentationNativeMotion | null) => void;
    read: () => RetainedPresentationNativeMotion | null;
    subscribe: (listener: () => void) => () => void;
}>;

/**
 * Pairs floating chrome with the retained body it presents. The frame's motion reaches the body
 * without rendering its presenter again, so a moving frame never re-presents the chrome.
 */
export function useRetainedPresentationFloatingBody(): RetainedPresentationFloatingBody {
    return React.useMemo(() => {
        let motion: RetainedPresentationNativeMotion | null = null;
        const listeners = new Set<() => void>();
        const channel: NativeMotionChannel = {
            publish(next) {
                if (next === motion) return;
                motion = next;
                for (const listener of [...listeners]) listener();
            },
            read: () => motion,
            subscribe(listener) {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
        };
        return {
            frame: (node) => <RetainedPresentationNativeMotionPublisherContext.Provider value={channel.publish}>
                {node}
            </RetainedPresentationNativeMotionPublisherContext.Provider>,
            body: (node) => <RetainedPresentationFloatingBodyScope channel={channel}>{node}</RetainedPresentationFloatingBodyScope>,
        };
    }, []);
}

function RetainedPresentationFloatingBodyScope(props: React.PropsWithChildren<Readonly<{ channel: NativeMotionChannel }>>): React.ReactElement {
    const motion = React.useSyncExternalStore(props.channel.subscribe, props.channel.read, props.channel.read);
    return <RetainedPresentationFloatingContext.Provider value>
        <RetainedPresentationNativeMotionContext.Provider value={motion}>{props.children}</RetainedPresentationNativeMotionContext.Provider>
    </RetainedPresentationFloatingContext.Provider>;
}

/** Route-stable source bodies share one presentation-slot portal across panes and routes. */
export type RetainedPresentationSlotEntry = Readonly<{
    /** Stable per-surface slot id (`presentationSlotId`). */
    slotId: string;
    /** The webview-bearing subtree to keep mounted above the router. */
    node: React.ReactNode;
    /** Last valid placeholder placement; visibility separately parks the retained body. */
    geometry: RetainedPresentationRect | null;
    clipGeometry?: RetainedPresentationRect | null;
    refreshGeometry?: (target?: EventTarget | null) => void;
    /** Whether the panel placeholder is currently on-screen (hidden ⇒ kept mounted off-screen). */
    visible: boolean;
    transition?: RetainedPresentationGeometryTransition | null;
    /**
     * The body is only being watched: the pointer passes through all of it to whatever presents it
     * (a floating frame beneath moves and expands by it). Keyboard focus is unaffected.
     */
    inputPassthrough?: boolean;
    nativeMotion?: RetainedPresentationNativeMotion | null;
    /** Bound under the floating layer: it paints above in-flow bodies and the floating chrome. */
    floating?: boolean;
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
    /** Explicit close; a retiring rendered owner must not remove a newer binding of the same slot. */
    removePortalEntry: (slotId: string, expected?: Readonly<{ node: React.ReactNode }>) => void;
    /** Refresh only presented entries; parked sources have no active geometry owner. */
    refreshPortalGeometry: (target?: EventTarget | null) => void;
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
        && a.refreshGeometry === b.refreshGeometry
        && (a.inputPassthrough ?? false) === (b.inputPassthrough ?? false)
        && (a.floating ?? false) === (b.floating ?? false)
        && a.transition?.durationMs === b.transition?.durationMs
        && a.transition?.easingCss === b.transition?.easingCss
        && a.transition?.properties === b.transition?.properties
        && a.geometry?.x === b.geometry?.x
        && a.geometry?.y === b.geometry?.y
        && a.geometry?.width === b.geometry?.width
        && a.geometry?.height === b.geometry?.height
        && rectsEqual(a.clipGeometry ?? null, b.clipGeometry ?? null);
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
        refreshPortalGeometry(target) {
            for (const entry of portalSnapshot) {
                if (entry.visible) entry.refreshGeometry?.(target);
            }
        },
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

/** Bind an existing retention owner without mounting another portal host. */
export function RetainedPresentationSlotsScope(props: React.PropsWithChildren<Readonly<{
    store: RetainedPresentationSlotsStore;
}>>): React.ReactElement {
    return <RetainedPresentationSlotsContext.Provider value={props.store}>{props.children}</RetainedPresentationSlotsContext.Provider>;
}

const portalStyles = StyleSheet.create(() => ({
    // The overlay container fills the app and never intercepts touches itself — only the positioned
    // webview slots are interactive (`box-none`).
    overlay: {
        ...StyleSheet.absoluteFillObject,
    },
    floatingLayer: {
        ...StyleSheet.absoluteFillObject,
        zIndex: FLOATING_LAYER_Z_INDEX,
    },
}));

/**
 * Route-stable portal host. Renders every registered webview subtree ONCE, above the route Stack,
 * each positioned over its panel placeholder by the slot geometry. Because this host is mounted in the
 * provider (outside the router), the webview React instance survives panel unmount/remount — a route
 * change repositions the overlay instead of reloading the page.
 */
export function RetainedPresentationPortalHost(props: Readonly<{
    /** Only the app root's portal hosts the floating layer; see `RetainedPresentationFloatingLayer`. */
    floatingLayerRef?: (node: View | null) => void;
    /** Native: the chrome presented into the layer, drawn inside it. */
    floatingChrome?: React.ReactNode;
    onFloatingLayerLayout?: () => void;
}> = {}): React.ReactElement | null {
    const store = React.useContext(RetainedPresentationSlotsContext);
    const overlayRef = React.useRef<View | null>(null);
    const [origin, setOrigin] = React.useState({ x: 0, y: 0 });
    const measureOrigin = React.useCallback(() => {
        overlayRef.current?.measureInWindow((x, y) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            setOrigin(previous => previous.x === x && previous.y === y ? previous : { x, y });
        });
    }, []);
    const subscribe = React.useCallback(
        (listener: () => void) => (store ? store.subscribePortal(listener) : () => {}),
        [store],
    );
    const getSnapshot = React.useCallback(
        (): readonly RetainedPresentationSlotEntry[] => (store ? store.getPortalSnapshot() : EMPTY_PORTAL_ENTRIES),
        [store],
    );
    const entries = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const geometryDemanded = entries.some(entry => entry.visible && entry.refreshGeometry !== undefined);
    React.useEffect(() => {
        if (!store || !geometryDemanded || Platform.OS !== 'web' || typeof window === 'undefined') return;
        const refresh = (event: Event) => { store.refreshPortalGeometry(event.target); measureOrigin(); };
        window.addEventListener('scroll', refresh, true);
        window.addEventListener('resize', refresh);
        return () => { window.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh); };
    }, [geometryDemanded, measureOrigin, store]);
    React.useLayoutEffect(() => {
        if (!geometryDemanded || Platform.OS !== 'web') return;
        return observeWebRetainedPresentationLayout(overlayRef.current, measureOrigin);
    }, [geometryDemanded, measureOrigin]);
    // A destination can occupy a split pane rather than the whole window. Binders measure in
    // window coordinates; subtract this portal's live origin without moving its retained DOM.
    React.useLayoutEffect(measureOrigin);
    if (entries.length === 0 && !props.floatingLayerRef) {
        return null;
    }
    return (
        <View ref={overlayRef} onLayout={measureOrigin} testID="browser-presentation-portal-host" style={portalStyles.overlay} pointerEvents="box-none">
            {props.floatingLayerRef ? (
                // Ordered by z-index, never by moving slots: a moved DOM node would reload its iframe.
                <View ref={props.floatingLayerRef} onLayout={props.onFloatingLayerLayout} collapsable={false}
                    testID="retained-presentation-floating-layer" style={portalStyles.floatingLayer} pointerEvents="box-none">
                    {props.floatingChrome}
                </View>
            ) : null}
            {entries.map((entry) => (
                <RetainedPresentationPortalSlot
                    key={entry.slotId}
                    entry={entry}
                    origin={origin}
                />
            ))}
        </View>
    );
}

function RetainedPresentationPortalSlot({ entry, origin }: Readonly<{ entry: RetainedPresentationSlotEntry; origin: Readonly<{ x: number; y: number }> }>) {
    const store = React.useContext(RetainedPresentationSlotsContext);
    const motion = entry.nativeMotion;
    // Keep React overlay elements and JS custody callbacks out of animated worklet closures.
    const x = motion?.x;
    const y = motion?.y;
    const width = motion?.width;
    const height = motion?.height;
    const anchorX = motion?.anchorX ?? 0;
    const anchorY = motion?.anchorY ?? 0;
    const chromeHeight = motion?.chromeHeight ?? 0;
    const clipped = React.useMemo(() => entry.geometry && entry.clipGeometry
        ? intersectRetainedPresentationRects(entry.geometry, entry.clipGeometry) : entry.geometry,
    [entry.geometry, entry.clipGeometry]);
    const visible = entry.visible && !!clipped && clipped.width > 0 && clipped.height > 0;
    const body = <RetainedPresentationEntryLifetime entry={entry} store={store}>
        <PluginSurfaceFocusEligibilityProvider active={visible}>
            <RetainedPresentationSlotGeometryProvider slotId={entry.slotId} rect={clipped}>
                {entry.node}
            </RetainedPresentationSlotGeometryProvider>
        </PluginSurfaceFocusEligibilityProvider>
    </RetainedPresentationEntryLifetime>;
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
        {...resolvePaneUnderlayAccessibilityProps(!visible, Platform.OS === 'web')}
        style={Platform.OS === 'web' ? resolvePortalSlotStyle(entry, origin) : [resolvePortalSlotStyle(entry, origin), animatedStyle]}
        pointerEvents={visible && motion?.overlay ? 'box-none' : visible && !entry.inputPassthrough ? 'auto' : 'none'}
    >
        <View style={entry.geometry && clipped && entry.clipGeometry ? {
            position: 'absolute', left: entry.geometry.x - clipped.x, top: entry.geometry.y - clipped.y,
            width: entry.geometry.width, height: entry.geometry.height,
        } : { flex: 1 }} pointerEvents={visible && !entry.inputPassthrough ? 'auto' : 'none'}>{body}</View>
        {visible ? motion?.overlay : null}
    </Animated.View>;
}

const EMPTY_PORTAL_ENTRIES: readonly RetainedPresentationSlotEntry[] = [];

/**
 * Position a portal slot over its panel placeholder. A hidden slot (route changed away, or no measured
 * geometry yet) is kept MOUNTED but parked off-screen so its native/DOM webview is preserved without
 * painting over the active route.
 */
function resolvePortalSlotStyle(entry: RetainedPresentationSlotEntry, origin: Readonly<{ x: number; y: number }>): ViewStyle {
    const rect = entry.geometry && entry.clipGeometry
        ? intersectRetainedPresentationRects(entry.geometry, entry.clipGeometry) : entry.geometry;
    if (!entry.visible || !rect || rect.width <= 0 || rect.height <= 0) {
        return { position: 'absolute', left: -100000, top: 0, width: 1, height: 1, opacity: 0 };
    }
    return {
        // The frame owner's placement: on web a transform, so the slot and a settling frame travel
        // on the compositor together; native keeps its offsets under the shared native motion.
        ...resolveFloatingFramePlacementStyle({ ...rect, x: rect.x - origin.x, y: rect.y - origin.y }),
        ...(entry.clipGeometry ? { overflow: 'hidden' as const } : {}),
        ...(entry.floating ? { zIndex: FLOATING_BODY_Z_INDEX } : {}),
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
    const [layerNode, setLayerNode] = React.useState<View | null>(null);
    // Native draws presented chrome inside the layer itself, once it knows where the layer stands.
    const [nativeLayerRect, setNativeLayerRect] = React.useState<RetainedPresentationRect | null>(null);
    const [nativeChrome, setNativeChrome] = React.useState<ReadonlyMap<string, React.ReactNode>>(EMPTY_FLOATING_CHROME);
    const measureNativeLayer = React.useCallback(() => {
        layerNode?.measureInWindow?.((x, y, width, height) => {
            if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
            const next = { x, y, width, height };
            setNativeLayerRect(previous => rectsEqual(previous, next) ? previous : next);
        });
    }, [layerNode]);
    const placeNativeChrome = React.useCallback((id: string, node: React.ReactNode | null) => {
        setNativeChrome((previous) => {
            if (node === null ? !previous.has(id) : previous.get(id) === node) return previous;
            const next = new Map(previous);
            if (node === null) next.delete(id);
            else next.set(id, node);
            return next;
        });
    }, []);
    const floatingLayer = React.useMemo(() => Platform.OS === 'web'
        ? resolveWebFloatingLayer(layerNode)
        : resolveNativeFloatingLayer(nativeLayerRect, placeNativeChrome), [layerNode, nativeLayerRect, placeNativeChrome]);
    return (
        <RetainedPresentationSlotsContext.Provider value={storeRef.current}>
            <RetainedPresentationFloatingLayerContext.Provider value={floatingLayer}>
                {props.children}
            </RetainedPresentationFloatingLayerContext.Provider>
            <RetainedPresentationPortalHost
                floatingLayerRef={setLayerNode}
                onFloatingLayerLayout={Platform.OS === 'web' ? undefined : measureNativeLayer}
                floatingChrome={Platform.OS === 'web' ? undefined : Array.from(nativeChrome, ([id, node]) => (
                    <React.Fragment key={id}>{node}</React.Fragment>
                ))}
            />
        </RetainedPresentationSlotsContext.Provider>
    );
}

const EMPTY_FLOATING_CHROME: ReadonlyMap<string, React.ReactNode> = new Map();

/** Native draws presented chrome in the root layer; the layer stands where it measured itself. */
function resolveNativeFloatingLayer(
    rect: RetainedPresentationRect | null,
    place: (id: string, node: React.ReactNode | null) => void,
): RetainedPresentationFloatingLayer | null {
    if (!rect) return null;
    return {
        present: (child) => <NativeFloatingLayerEntry place={place}>{child}</NativeFloatingLayerEntry>,
        measure: () => rect,
    };
}

function NativeFloatingLayerEntry(props: React.PropsWithChildren<Readonly<{
    place: (id: string, node: React.ReactNode | null) => void;
}>>): null {
    const id = React.useId();
    const { place, children } = props;
    React.useLayoutEffect(() => { place(id, children); }, [children, id, place]);
    React.useLayoutEffect(() => () => place(id, null), [id, place]);
    return null;
}

/** On web the layer's host node is its DOM element: chrome portals into it with React DOM. */
function resolveWebFloatingLayer(node: unknown): RetainedPresentationFloatingLayer | null {
    if (Platform.OS !== 'web' || !node) return null;
    const element = node as { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } };
    if (typeof element.getBoundingClientRect !== 'function') return null;
    const createPortal = (requireReactDOM() as { createPortal?: (child: React.ReactNode, target: unknown) => React.ReactNode }).createPortal;
    if (!createPortal) return null;
    return {
        present: (child) => createPortal(child, node),
        measure: () => {
            const rect = element.getBoundingClientRect!();
            return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        },
    };
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
    clipGeometry?: RetainedPresentationRect | null;
    refreshGeometry?: (target?: EventTarget | null) => void;
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
    /** A source can dispose on ordinary exit while retaining an actual route handoff. */
    retainOnUnmount?: () => boolean;
}>;

export type UseRetainedPresentationSlotResult = Readonly<{
    /** Whether the webview is being hosted by the route-stable portal (vs. rendered inline). */
    portalActive: boolean;
}>;

/**
 * Bind a slot's webview subtree into the route-stable portal. The binder calls this on every commit
 * so the `node` + geometry stay fresh; crucially it does NOT remove the entry when the binder
 * unmounts — that retention is what preserves the webview across a route change. Unmount parks the
 * entry off-screen/non-interactive. Sources may opt into ordinary-exit disposal with
 * `retainOnUnmount`; replacement binders take custody before that disposal. Otherwise an explicit
 * close or closed lifecycle removes the entry. With no provider (or `enabled` false) the hook is inert and
 * `portalActive` is false, so the caller renders inline and behavior is unchanged.
 */
export function useRetainedPresentationSlot(
    input: UseRetainedPresentationSlotInput,
): UseRetainedPresentationSlotResult {
    const store = React.useContext(RetainedPresentationSlotsContext);
    const floating = React.useContext(RetainedPresentationFloatingContext);
    const enabled = (input.enabled ?? true) && store !== null;
    const layoutActive = useLayoutPresentationActive();
    const visible = layoutActive && (input.visible ?? true);
    // Each slot activation keeps only its committed registration. An aborted render or a later
    // slot id must not redirect the retiring binder's expected-node cleanup.
    const registration = React.useMemo(() => ({ input }), [enabled, input.slotId, store]);

    React.useLayoutEffect(() => {
        if (!enabled || !store) return;
        registration.input = input;
        store.upsertPortalEntry({
            slotId: input.slotId,
            node: input.node,
            geometry: input.geometry ?? null,
            clipGeometry: input.clipGeometry,
            refreshGeometry: input.refreshGeometry,
            visible,
            transition: input.transition ?? null,
            inputPassthrough: input.inputPassthrough ?? false,
            nativeMotion: input.nativeMotion ?? null,
            floating,
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

    React.useEffect(() => {
        if (!enabled || !store) return;
        return () => {
            // Replacement binders publish during layout. Retire an ordinary exit afterwards,
            // only if this is still our node; a same-commit presenter handoff keeps its body.
            if (registration.input.retainOnUnmount?.() === false) {
                store.removePortalEntry(input.slotId, { node: registration.input.node });
            }
        };
    }, [enabled, input.slotId, registration, store]);

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
    windowClipGeometry?: RetainedPresentationRect | null;
    transition?: RetainedPresentationGeometryTransition | null;
    /** See `RetainedPresentationSlotEntry.inputPassthrough`. */
    inputPassthrough?: boolean;
    children: React.ReactNode;
    retainOnUnmount?: () => boolean;
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
    const layoutActive = useLayoutPresentationActive();
    const viewport = React.useContext(RetainedPresentationViewportContext);
    const placeholderRef = React.useRef<View | null>(null);
    const [geometry, setGeometry] = React.useState<RetainedPresentationRect | null>(null);
    const [clipGeometry, setClipGeometry] = React.useState<RetainedPresentationRect | null>(null);
    const measurement = React.useRef(viewport);
    measurement.current = viewport;
    const updateGeometry = React.useCallback((next: RetainedPresentationRect | null) => {
        setGeometry((prev) => (rectsEqual(prev, next) ? prev : next));
    }, []);
    const measure = React.useCallback((target?: EventTarget | null) => {
        const node = placeholderRef.current;
        if (!node || typeof node.measureInWindow !== 'function') return;
        if (typeof Node !== 'undefined' && node instanceof Node && target instanceof Node && !target.contains(node)) return;
        const web = Platform.OS === 'web' ? readWebRetainedPresentationGeometry(node) : null;
        if (web) {
            updateGeometry(web.geometry);
            setClipGeometry(previous => rectsEqual(previous, web.clipGeometry) ? previous : web.clipGeometry);
            return;
        }
        node.measureInWindow((x, y, width, height) => {
            if (!Number.isFinite(width) || !Number.isFinite(height)) return;
            updateGeometry({ x, y, width, height });
        });
        if (measurement.current) measurement.current.measure(next => setClipGeometry(previous => rectsEqual(previous, next) ? previous : next));
        else setClipGeometry(previous => previous === null ? previous : null);
    }, [updateGeometry]);
    const onLayout = React.useCallback((_event: LayoutChangeEvent) => {
        // `onLayout` x/y are parent-relative; re-measure in window coordinates for the absolute overlay.
        measure();
    }, [measure]);
    const retainedCurrentUiContext = useRetainedCurrentUiContextNode(props.children);
    const retainedTab = useRetainedDetailsTabNode(retainedCurrentUiContext);
    const retainedDestination = useRetainedDestinationNode(retainedTab);
    // The body's pane scope keeps its right-sidebar chooser above the router (an ended preview's
    // Go to Services opens that scope's own Services tab). The owner is a stable ref per scope.
    const sideActions = React.useContext(RightSidebarActionsContext);
    // It also keeps the slot's bottom-chrome reservation: a phone cockpit screen that already reserves the
    // floating tab bar zeroes it for its subtree, and a body hosted above the router must not reserve it again.
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const retainedScope = React.useMemo(() => (
        <RightSidebarActionsContext.Provider value={sideActions}>
            <SessionCockpitBottomChromeHeightContext.Provider value={bottomChromeHeight}>{retainedDestination}</SessionCockpitBottomChromeHeightContext.Provider>
        </RightSidebarActionsContext.Provider>
    ), [bottomChromeHeight, retainedDestination, sideActions]);
    const retainedFocus = useRetainedPluginSurfaceFocusNode(retainedScope);
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
        // Explicit placement replaces measurement, including the placeholder's former pane clip.
        // A presentation that needs clipping supplies its matching windowClipGeometry explicitly.
        clipGeometry: props.windowClipGeometry !== undefined ? props.windowClipGeometry
            : props.windowGeometry !== undefined ? null : clipGeometry,
        refreshGeometry: measure,
        visible: props.visible ?? true,
        enabled: props.enabled,
        transition: props.transition,
        inputPassthrough: props.inputPassthrough,
        nativeMotion,
        retainOnUnmount: props.retainOnUnmount,
    });
    const measureLayout = props.windowGeometry === undefined && props.visible !== false && layoutActive;
    React.useLayoutEffect(() => {
        if (!portalActive || !measureLayout || Platform.OS !== 'web') return;
        return observeWebRetainedPresentationLayout(placeholderRef.current, measure);
    }, [measure, measureLayout, portalActive]);
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
