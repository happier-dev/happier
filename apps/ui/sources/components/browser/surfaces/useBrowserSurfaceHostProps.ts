import type {
    BrowserPlatformV1,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';
import * as React from 'react';
import { Platform } from 'react-native';

import type { BrowserControlState } from '@/sync/domains/browser/control';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { createBrowserViewState } from '@/sync/domains/browser/store';
import { buildBrowserLaunchpadModel } from '@/sync/domains/browser/targets';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { BrowserLaunchpadOpenTargetOptions } from '@/components/browser/launchpad/BrowserLaunchpad';
import {
    snapshotFromLocalServiceLauncherState,
    useLocalServiceLauncherStateController,
    type LocalServiceLauncherSnapshotClient,
    type LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import type { LocalServicePreviewSnapshotClient } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import {
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import { getPreferredLanguage } from '@/text';

import {
    reconcileBrowserPresentationSlots,
    type BrowserSurfaceLifecycleSnapshot,
} from './browserSurfaceLifecycle';
import { useOptionalBrowserPresentationRetentionStore } from './browserPresentationRetention';

/**
 * The first-party browser presentation surfaces (session/project right-sidebar wrappers,
 * the mobile cockpit screen, and the session/project details launchpad panels) all need the
 * same host wiring: resolve the browser platform once, derive deterministic
 * `browserSessionId`/`surfaceKey`/`presentationSlotId` strings, assemble the live launchpad
 * feed, and keep the logical browser view alive across pane-hide transitions.
 *
 * Before this owner existed each surface hand-rolled (and under-implemented) that wiring:
 * `resolveBrowserPlatform` was copy-pasted in five files and the browser seed state was created
 * per wrapper with no launchpad feed, so three of the four surfaces rendered an inert host.
 * `useBrowserSurfaceHostProps` is the single bootstrap owner those surfaces consume.
 */
export type BrowserSurfaceScope =
    | 'sessionSidebar'
    | 'projectSidebar'
    | 'sessionMobile'
    | 'sessionDetails'
    | 'workspaceDetails';

export type BrowserSurfaceHostFeedAssembly = Readonly<{
    rows: readonly BrowserLaunchpadRow[];
    refreshStatus: 'idle' | 'refreshing' | 'error';
    refreshError: string | null;
}>;

export type BrowserSurfaceHostPropsInput = Readonly<{
    scope: BrowserSurfaceScope;
    sessionId?: string | null;
    workspaceRefId?: string | null;
    machineId?: string | null;
    serverId?: string | null;
    platform?: BrowserPlatformV1 | LocalServicePreviewPlatform | null;
    nowMs?: () => number;
    /**
     * Inject a launcher state to bypass the live machine-RPC controller (mirrors
     * `SessionDetailsPanel`'s `props.localServiceLauncherState ?? live` pattern). Passing a value
     * (including `null`) disables the live controller; leaving it `undefined` uses the live feed.
     */
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    /** Same injection contract as `launcherState` for the local-service preview feed. */
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewSnapshotClient?: LocalServicePreviewSnapshotClient;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginBrowserPolicyContext?: PluginUiPolicyEvaluationContext;
}>;

export type BrowserSurfaceHostPropsBundle = Readonly<{
    browserSessionId: string;
    platform: BrowserPlatformV1;
    initialBrowserState: BrowserControlState;
    surfaceKey: string;
    presentationSlotId: string;
    launchpadRows: readonly BrowserLaunchpadRow[];
    launchpadRefreshStatus: 'idle' | 'refreshing' | 'error';
    launchpadRefreshError: string | null;
    localServicePreviewState: LocalServicePreviewState | null;
    localServicePreviewServerId: string | null;
    feed: BrowserSurfaceHostFeedAssembly;
    onLifecycleChange: (snapshot: BrowserSurfaceLifecycleSnapshot) => void;
    /**
     * Whether the scope-level keep-alive owner is still retaining a logical browser view (i.e. the
     * surface has been mounted and has not been closed). Stays true across a pane hide so the view is
     * not treated as fresh on re-show (BRW-13 §4a — visibility is not lifetime).
     */
    isLogicalViewRetained: () => boolean;
}>;

function isBrowserPlatform(value: unknown): value is BrowserPlatformV1 {
    return value === 'web' || value === 'desktop' || value === 'ios' || value === 'android';
}

/**
 * Single platform resolver subsuming the five deleted `resolveBrowserPlatform` copies.
 *
 * Tauri runs the WEB bundle, so `Platform.OS === 'web'` inside the desktop app; the resolver MUST
 * consult `isDesktopHost()` BEFORE `Platform.OS` or it would misclassify desktop as `web` (B-RC1).
 *
 * - An explicit `desktop`/`ios`/`android` override is a genuine cross-platform target and is
 *   returned unchanged (covers the `BrowserDetailsSurface`/`SessionBrowserSurfaceTab`
 *   preview-platform-override forms).
 * - An explicit `'web'` override is NOT honored under Tauri (B-3): every override-passing browser
 *   caller sources its value from a `LocalServicePreviewPlatform` (`"web" | "ios" | "android"`),
 *   which structurally cannot represent `'desktop'`, so inside the desktop app it always collapses to
 *   `'web'`. Honoring that leaked `'web'` made the selector pick the sandboxed `webIframe` engine
 *   instead of the native Wry `desktopWebView`. A `'web'` value is therefore treated as "no genuine
 *   override" and falls through to the Tauri-aware resolution below — a real browser still resolves to
 *   `'web'` because `isDesktopHost()` is false there.
 * - Otherwise: `desktop` inside Tauri, the native OS on device, and `web` in a plain browser.
 * - The `fallback` option is vestigial now that Tauri is detected directly (it no longer decides the
 *   desktop verdict); it is kept only for the one `SessionBrowserSurfaceTab` caller that still passes
 *   it and never overrides the Tauri result.
 */
export function resolveBrowserSurfacePlatform(
    explicit?: BrowserPlatformV1 | LocalServicePreviewPlatform | null,
    options?: Readonly<{ fallback?: 'desktop' | 'web' }>,
): BrowserPlatformV1 {
    // A genuine cross-platform override (`desktop`/`ios`/`android`) wins. `'web'` is excluded: it is
    // indistinguishable from the `LocalServicePreviewPlatform` leak (B-3), so it must defer to the
    // Tauri-aware resolution rather than short-circuit it.
    if (isBrowserPlatform(explicit) && explicit !== 'web') {
        return explicit;
    }
    if (isDesktopHost()) {
        return 'desktop';
    }
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
        return Platform.OS;
    }
    return 'web';
}

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

function resolveBrowserSessionId(input: BrowserSurfaceHostPropsInput): string {
    switch (input.scope) {
        case 'sessionSidebar':
            return `session:${normalizeId(input.sessionId) ?? 'unknown'}:right-sidebar`;
        case 'projectSidebar':
            return `project:${normalizeId(input.workspaceRefId) ?? 'unknown'}:right-sidebar`;
        case 'sessionMobile':
            return `session:${normalizeId(input.sessionId) ?? 'unknown'}:mobile-cockpit`;
        case 'sessionDetails':
            return `session:${normalizeId(input.sessionId) ?? 'unknown'}:details`;
        case 'workspaceDetails':
            return `project:${normalizeId(input.workspaceRefId) ?? 'unknown'}:details`;
        default: {
            const exhaustive: never = input.scope;
            return exhaustive;
        }
    }
}

/**
 * Centralized browser SurfaceHost bootstrap (BRW-13). Resolves identity/platform once, assembles
 * the live launchpad feed through the canonical owners, and returns a prop bundle the first-party
 * browser presentation adapters spread onto `BrowserSurfaceHost`.
 *
 * This is a React hook: it unconditionally calls `useLocalServiceLauncherStateController`,
 * `useLocalServicePreviewState`, and `React.useMemo/useRef/useCallback`, so it must obey the
 * Rules of Hooks (hence the `use` prefix). All call sites invoke it unconditionally at the top
 * level of a component.
 */
export function useBrowserSurfaceHostProps(
    input: BrowserSurfaceHostPropsInput,
): BrowserSurfaceHostPropsBundle {
    const platform = resolveBrowserSurfacePlatform(input.platform);
    const browserSessionId = resolveBrowserSessionId(input);
    const machineId = normalizeId(input.machineId);
    const serverId = normalizeId(input.serverId);

    const liveLauncherState = useLocalServiceLauncherStateController({
        machineId,
        serverId,
        sessionId: input.sessionId,
        enabled: input.launcherState === undefined,
        snapshotClient: input.launcherSnapshotClient,
        nowMs: input.nowMs,
    }).state;
    const launcherState = input.launcherState !== undefined
        ? input.launcherState
        : liveLauncherState;

    const liveLocalServicePreviewState = useLocalServicePreviewState({
        machineId,
        serverId,
        enabled: input.localServicePreviewState === undefined,
        snapshotClient: input.localServicePreviewSnapshotClient,
        nowMs: input.nowMs,
    });
    const localServicePreviewState = input.localServicePreviewState !== undefined
        ? input.localServicePreviewState
            : liveLocalServicePreviewState;
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = React.useMemo(
        () => createPluginLocalizedTextResolver({
            projection: input.pluginUiProjection,
            locale: pluginLocale,
        }),
        [input.pluginUiProjection, pluginLocale],
    );

    const feed = React.useMemo<BrowserSurfaceHostFeedAssembly>(() => buildBrowserLaunchpadModel({
        launcherSnapshot: snapshotFromLocalServiceLauncherState(launcherState),
        localServicePreviewState,
        pluginBrowserProjection: input.pluginBrowserProjection,
        localizePluginText,
        pluginBrowserPolicyContext: createPluginUiPolicyEvaluationContext(
            { platform },
            input.pluginBrowserPolicyContext,
        ),
        nowMs: input.nowMs?.(),
    }), [
        input.nowMs,
        input.pluginBrowserProjection,
        input.pluginBrowserPolicyContext,
        localizePluginText,
        launcherState,
        localServicePreviewState,
        platform,
    ]);

    // The reset key for `BrowserSurfaceHost` is its `surfaceKey`. Keeping it stable for a given
    // logical view is what preserves in-host browser state across pane-hide/show transitions, so it
    // must depend only on the surface identity — never on the launchpad feed which churns on refresh.
    const surfaceKey = React.useMemo(
        () => `${browserSessionId}:launchpad`,
        [browserSessionId],
    );
    const presentationSlotId = React.useMemo(
        () => `${browserSessionId}:slot`,
        [browserSessionId],
    );
    const initialBrowserState = React.useMemo(
        // Seed via the canonical store-level factory (same as the details-surface path) so the
        // launchpad host starts from an empty view. Tie it to the stable surface identity so
        // visibility toggles do not reset it.
        () => createBrowserViewState(),
        [surfaceKey],
    );

    // Keep-alive owner: consume the lifecycle snapshots the host emits and retain a reconciled
    // snapshot per logical view so the surface survives a pane hide instead of resetting to a fresh
    // host (BRW-13 §4a — visibility is not lifetime). `reconcileBrowserPresentationSlots` carries the
    // previous slots forward as dormant when the view becomes hidden/orphaned, so a hidden→visible
    // toggle keeps the same logical view rather than re-seeding it. The view is dropped only on a
    // real `closed` lifecycle, never on a transient hide.
    //
    // UX-6: retention now lives in a route-stable provider mounted ABOVE the router (keyed by this
    // surface's `presentationSlotId`) so a full panel unmount / surface switch no longer remounts the
    // webview. When no provider is mounted (isolated tests / not-yet-wrapped surfaces) it falls back
    // to a component-local ref, preserving the previous behavior exactly.
    const retentionStore = useOptionalBrowserPresentationRetentionStore();
    const fallbackRetainedRef = React.useRef<Map<string, BrowserSurfaceLifecycleSnapshot>>(new Map());
    const onLifecycleChange = React.useCallback((snapshot: BrowserSurfaceLifecycleSnapshot) => {
        if (retentionStore) {
            retentionStore.recordLifecycle(presentationSlotId, snapshot);
            return;
        }
        const retained = fallbackRetainedRef.current;
        if (snapshot.lifecycleState === 'closed') {
            retained.delete(snapshot.logicalViewId);
            return;
        }
        const reconciled = reconcileBrowserPresentationSlots({
            logicalViewId: snapshot.logicalViewId,
            previous: retained.get(snapshot.logicalViewId) ?? null,
            nextSlots: Object.values(snapshot.slotsById),
            hostAvailability: 'available',
        });
        retained.set(snapshot.logicalViewId, reconciled);
    }, [presentationSlotId, retentionStore]);
    const isLogicalViewRetained = React.useCallback(
        () => (retentionStore
            ? retentionStore.isRetained(presentationSlotId)
            : fallbackRetainedRef.current.size > 0),
        [presentationSlotId, retentionStore],
    );

    return React.useMemo<BrowserSurfaceHostPropsBundle>(() => ({
        browserSessionId,
        platform,
        initialBrowserState,
        surfaceKey,
        presentationSlotId,
        launchpadRows: feed.rows,
        launchpadRefreshStatus: feed.refreshStatus,
        launchpadRefreshError: feed.refreshError,
        localServicePreviewState,
        localServicePreviewServerId: serverId,
        feed,
        onLifecycleChange,
        isLogicalViewRetained,
    }), [
        browserSessionId,
        feed,
        initialBrowserState,
        isLogicalViewRetained,
        localServicePreviewState,
        onLifecycleChange,
        platform,
        presentationSlotId,
        serverId,
        surfaceKey,
    ]);
}
