import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { View, type LayoutChangeEvent } from 'react-native';

import {
    reconcileBrowserPresentationSlots,
    type BrowserSurfaceLifecycleSnapshot,
    type BrowserSurfaceRect,
} from './browserSurfaceLifecycle';

/**
 * UX-6: browser keep-alive retention + webview portal, hoisted ABOVE the router.
 *
 * Retention used to live in a `useRef` inside `useBrowserSurfaceHostProps`, which is mounted inside
 * the (unmounting) browser panel. A surface switch / panel unmount therefore destroyed the retained
 * snapshots AND remounted the webview, reloading the page. This store now owns two things in a
 * route-stable provider mounted once outside the route stack:
 *
 *  1. the retained lifecycle snapshots (`recordLifecycle` / `isRetained`), keyed by
 *     `presentationSlotId`; and
 *  2. a webview PORTAL registry (`upsertPortalEntry` / `removePortalEntry`) keyed by the same slot id.
 *     The actual webview subtree is rendered by `BrowserPresentationPortalHost` — which is mounted in
 *     the provider, ABOVE the route Stack — so a sidebar toggle / route change unmounts only the panel
 *     placeholder, never the webview. The panel binds via `presentationSlotId` for geometry; the
 *     webview React instance (and its native/DOM view) is preserved across the route change.
 *
 * The reconcile LOGIC is unchanged (`reconcileBrowserPresentationSlots`); only WHERE the retained map
 * and the webview subtree live moved.
 */
export type BrowserPresentationPortalEntry = Readonly<{
    /** Stable per-surface slot id (`presentationSlotId`). */
    slotId: string;
    /** The webview-bearing subtree to keep mounted above the router. */
    node: React.ReactNode;
    /** Where the panel placeholder is, so the portal overlay paints over it. */
    geometry: BrowserSurfaceRect | null;
    /** Whether the panel placeholder is currently on-screen (hidden ⇒ kept mounted off-screen). */
    visible: boolean;
}>;

export type BrowserPresentationRetentionStore = Readonly<{
    /** Fold a host lifecycle snapshot into the retention for a surface slot. */
    recordLifecycle: (slotId: string, snapshot: BrowserSurfaceLifecycleSnapshot) => void;
    /** Whether the surface slot still retains at least one logical view (i.e. not fully closed). */
    isRetained: (slotId: string) => boolean;
    /**
     * Register / update the webview subtree to render in the route-stable portal for a slot. Called on
     * every binder commit so the node + geometry stay fresh; the entry SURVIVES the binder's unmount
     * (that is the keep-alive) and is removed only by `removePortalEntry` or a `closed` lifecycle.
     */
    upsertPortalEntry: (entry: BrowserPresentationPortalEntry) => void;
    /** Preserve a retained webview but park it off-screen while no binder owns the visible route. */
    parkPortalEntry: (slotId: string) => void;
    /** Explicitly tear down a slot's portal-hosted webview (real close, not a route change). */
    removePortalEntry: (slotId: string) => void;
    /** Referentially-stable snapshot of the registered portal entries (for `useSyncExternalStore`). */
    getPortalSnapshot: () => readonly BrowserPresentationPortalEntry[];
    /** Subscribe to portal-registry mutations. */
    subscribePortal: (listener: () => void) => () => void;
}>;

function portalEntriesEqual(
    a: BrowserPresentationPortalEntry,
    b: BrowserPresentationPortalEntry,
): boolean {
    return a.slotId === b.slotId
        && a.node === b.node
        && a.visible === b.visible
        && a.geometry?.x === b.geometry?.x
        && a.geometry?.y === b.geometry?.y
        && a.geometry?.width === b.geometry?.width
        && a.geometry?.height === b.geometry?.height;
}

export function createBrowserPresentationRetentionStore(): BrowserPresentationRetentionStore {
    // slotId -> (logicalViewId -> reconciled snapshot)
    const bySlot = new Map<string, Map<string, BrowserSurfaceLifecycleSnapshot>>();

    // Portal registry. Insertion-ordered so the overlay paint order is stable; a cached snapshot array
    // keeps `getPortalSnapshot` referentially stable between mutations (required by useSyncExternalStore).
    const portalBySlot = new Map<string, BrowserPresentationPortalEntry>();
    const portalListeners = new Set<() => void>();
    let portalSnapshot: readonly BrowserPresentationPortalEntry[] = [];

    function rebuildPortalSnapshot(): void {
        portalSnapshot = Array.from(portalBySlot.values());
    }
    function notifyPortal(): void {
        for (const listener of [...portalListeners]) listener();
    }

    function removePortalEntry(slotId: string): void {
        if (!portalBySlot.delete(slotId)) return;
        rebuildPortalSnapshot();
        notifyPortal();
    }

    function parkPortalEntry(slotId: string): void {
        const existing = portalBySlot.get(slotId);
        if (!existing) return;
        const next = {
            ...existing,
            geometry: null,
            visible: false,
        };
        if (portalEntriesEqual(existing, next)) return;
        portalBySlot.set(slotId, next);
        rebuildPortalSnapshot();
        notifyPortal();
    }

    return {
        recordLifecycle(slotId, snapshot) {
            const bucket = bySlot.get(slotId);
            if (snapshot.lifecycleState === 'closed') {
                // A real close drops both the retention bookkeeping AND the portal-hosted webview, so a
                // closed surface never lingers mounted above the router.
                removePortalEntry(slotId);
                if (!bucket) return;
                bucket.delete(snapshot.logicalViewId);
                if (bucket.size === 0) bySlot.delete(slotId);
                return;
            }
            // A presentation slot presents exactly ONE logical view at a time (the focused view the
            // host emits). This store is route-stable and lives for the app's entire lifetime, so a
            // bucket keyed by every `logicalViewId` ever focused would grow unboundedly as tabs churn
            // — and the host never emits a `closed` lifecycle, so the delete branch above never fires
            // in production. Retain only the active logical view per slot: carry the previous snapshot
            // forward for the SAME view (dormant-slot reconcile across a hide→show) and replace a stale
            // view when the slot switches to a different one, so each slot holds exactly one entry.
            const previous = bucket?.get(snapshot.logicalViewId) ?? null;
            const reconciled = reconcileBrowserPresentationSlots({
                logicalViewId: snapshot.logicalViewId,
                previous,
                nextSlots: Object.values(snapshot.slotsById),
                hostAvailability: 'available',
            });
            bySlot.set(slotId, new Map([[snapshot.logicalViewId, reconciled]]));
        },
        isRetained(slotId) {
            const bucket = bySlot.get(slotId);
            return bucket ? bucket.size > 0 : false;
        },
        upsertPortalEntry(entry) {
            const existing = portalBySlot.get(entry.slotId);
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

const BrowserPresentationRetentionContext = React.createContext<BrowserPresentationRetentionStore | null>(null);

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
export function BrowserPresentationPortalHost(): React.ReactElement | null {
    const store = React.useContext(BrowserPresentationRetentionContext);
    const subscribe = React.useCallback(
        (listener: () => void) => (store ? store.subscribePortal(listener) : () => {}),
        [store],
    );
    const getSnapshot = React.useCallback(
        (): readonly BrowserPresentationPortalEntry[] => (store ? store.getPortalSnapshot() : EMPTY_PORTAL_ENTRIES),
        [store],
    );
    const entries = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (entries.length === 0) {
        return null;
    }
    return (
        <View testID="browser-presentation-portal-host" style={portalStyles.overlay} pointerEvents="box-none">
            {entries.map((entry) => (
                <View
                    key={entry.slotId}
                    testID={`browser-presentation-portal-slot-${entry.slotId}`}
                    style={resolvePortalSlotStyle(entry)}
                    pointerEvents={entry.visible ? 'auto' : 'none'}
                >
                    {entry.node}
                </View>
            ))}
        </View>
    );
}

const EMPTY_PORTAL_ENTRIES: readonly BrowserPresentationPortalEntry[] = [];

/**
 * Position a portal slot over its panel placeholder. A hidden slot (route changed away, or no measured
 * geometry yet) is kept MOUNTED but parked off-screen so its native/DOM webview is preserved without
 * painting over the active route.
 */
function resolvePortalSlotStyle(entry: BrowserPresentationPortalEntry): {
    position: 'absolute';
    left: number;
    top: number;
    width: number;
    height: number;
    opacity?: number;
} {
    const rect = entry.geometry;
    if (!entry.visible || !rect || rect.width <= 0 || rect.height <= 0) {
        return { position: 'absolute', left: -100000, top: 0, width: 1, height: 1, opacity: 0 };
    }
    return {
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
    };
}

/**
 * Route-stable retention + portal provider. Mount once OUTSIDE the route stack (the app root layout)
 * so a single store + portal host survive every route/panel mount-unmount cycle.
 */
export function BrowserPresentationRetentionProvider(
    props: React.PropsWithChildren,
): React.ReactElement {
    const storeRef = React.useRef<BrowserPresentationRetentionStore | null>(null);
    if (storeRef.current === null) {
        storeRef.current = createBrowserPresentationRetentionStore();
    }
    return (
        <BrowserPresentationRetentionContext.Provider value={storeRef.current}>
            {props.children}
            <BrowserPresentationPortalHost />
        </BrowserPresentationRetentionContext.Provider>
    );
}

/**
 * Read the route-stable retention store. Returns `null` when no provider is mounted (e.g. isolated
 * tests / surfaces not yet under the provider); callers fall back to component-local retention so
 * behavior is unchanged in that case.
 */
export function useOptionalBrowserPresentationRetentionStore(): BrowserPresentationRetentionStore | null {
    return React.useContext(BrowserPresentationRetentionContext);
}

export type UseBrowserPresentationPortalSlotInput = Readonly<{
    slotId: string;
    node: React.ReactNode;
    geometry?: BrowserSurfaceRect | null;
    visible?: boolean;
    /**
     * When `true`, this binder is the active host for the slot and registers its `node` into the
     * route-stable portal. When `false` (no provider, or the caller opted out), nothing is registered
     * and the caller renders the `node` inline itself.
     */
    enabled?: boolean;
}>;

export type UseBrowserPresentationPortalSlotResult = Readonly<{
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
export function useBrowserPresentationPortalSlot(
    input: UseBrowserPresentationPortalSlotInput,
): UseBrowserPresentationPortalSlotResult {
    const store = React.useContext(BrowserPresentationRetentionContext);
    const enabled = (input.enabled ?? true) && store !== null;

    React.useEffect(() => {
        if (!enabled || !store) return;
        store.upsertPortalEntry({
            slotId: input.slotId,
            node: input.node,
            geometry: input.geometry ?? null,
            visible: input.visible ?? true,
        });
    });

    React.useEffect(() => {
        if (!enabled || !store) return undefined;
        return () => {
            // Do not remove the entry: keep the webview mounted, but make it non-interactive while no
            // route/panel binder owns its visible geometry.
            store.parkPortalEntry(input.slotId);
        };
    }, [enabled, input.slotId, store]);

    return { portalActive: enabled };
}

function rectsEqual(a: BrowserSurfaceRect | null, b: BrowserSurfaceRect | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export type BrowserKeepAliveBinderProps = Readonly<{
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
export function BrowserKeepAliveBinder(props: BrowserKeepAliveBinderProps): React.ReactElement {
    const placeholderRef = React.useRef<View | null>(null);
    const [geometry, setGeometry] = React.useState<BrowserSurfaceRect | null>(null);
    const updateGeometry = React.useCallback((next: BrowserSurfaceRect | null) => {
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

    const { portalActive } = useBrowserPresentationPortalSlot({
        slotId: props.slotId,
        node: props.children,
        geometry,
        visible: props.visible ?? true,
        enabled: props.enabled,
    });

    if (!portalActive) {
        return <>{props.children}</>;
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
