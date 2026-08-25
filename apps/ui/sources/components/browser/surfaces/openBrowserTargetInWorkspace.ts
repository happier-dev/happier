import type {
    BrowserPlatformV1,
    BrowserProfileV1,
    BrowserViewTargetV1,
    FeatureDecision,
    LocalServiceLaunchTargetV1,
} from '@happier-dev/protocol';

import type { BrowserLaunchpadOpenTargetOptions } from '@/components/browser/launchpad/BrowserLaunchpad';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import {
    openBrowserExternalTabSelection,
    selectBrowserTargetAdapter,
} from '@/sync/domains/browser/adapters/selection';
import { evaluateBrowserTargetPolicy } from '@/sync/domains/browser/policy/evaluate';
import { resolveLocalBrowserProfile } from '@/sync/domains/browser/profiles/localBrowserProfile';
import {
    createBrowserViewState,
    openBrowserTarget,
    resolveBrowserViewIdForTarget,
} from '@/sync/domains/browser/store';
import type { BrowserViewState } from '@/sync/domains/browser/types';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { selectLocalServicePreviewByBrowserTarget } from '@/sync/domains/local/services/preview/store';

import {
    createBrowserViewDetailsTab,
    resolveBrowserTargetSurfaceSessionId,
} from './browserSurfaceDetailsTabModel';

/**
 * Where an "open target as a browser view" originates. Desktop scopes own a side-by-side
 * details workspace (a real tab); the mobile full-screen surface is a single host. The scope
 * also selects the surface-session-id namespace so the seeded content record and the tab the
 * host later mounts agree on identity.
 */
export type OpenBrowserTargetScope = 'sessionDetails' | 'workspaceDetails' | 'sessionMobile';

type OpenDetailsTab = (
    tab: DetailsTab,
    options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>,
) => void;

/**
 * Pure inputs shared by the tab builder and the content-record seed so the two cannot diverge.
 * The same shape feeds {@link resolveBrowserViewTargetOpen} (pure) and the side-effecting
 * {@link createOpenBrowserTargetInWorkspace}.
 */
export type ResolveBrowserViewTargetOpenInput = Readonly<{
    scope: OpenBrowserTargetScope;
    platform: BrowserPlatformV1;
    localServicePreviewState?: LocalServicePreviewState | null;
    browserFeatureDecision?: FeatureDecision | null;
    browserProfile?: BrowserProfileV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
}>;

export type CreateOpenBrowserTargetInWorkspaceDeps = ResolveBrowserViewTargetOpenInput & Readonly<{
    openDetailsTab: OpenDetailsTab;
    /**
     * Records the opened target as a recent. Supplied by the caller because the recents store lives
     * outside this owner (FP-BRW-LAUNCHER-1 wires it to the launchpad's recent section); fold the
     * target via the canonical `rememberBrowserRecentTarget` reducer in `targets/recents.ts`.
     */
    onRememberRecentTarget?: (target: BrowserViewTargetV1) => void;
}>;

/**
 * The deterministic open INPUTS for a target: the `browser-view` tab (carrying ONLY `target` +
 * identity) plus the resolved current-url seam. This is what the side-effecting opener needs — it
 * does NOT carry a materialized `BrowserViewState` (DV-OPEN-SEAM: the live record is derived ONCE,
 * at the renderer's `createInitialBrowserState`, from the resource's `target` via the same
 * `openBrowserTarget` resolver — never stashed as a mutable blob on the resource).
 */
export type ResolvedBrowserViewTargetOpenTab = Readonly<{
    tab: DetailsTab;
    browserSessionId: string;
    viewId: string;
    currentUrl?: string;
    currentUrlExpiresAt?: number;
}>;

export type ResolvedBrowserViewTargetOpen = ResolvedBrowserViewTargetOpenTab & Readonly<{
    /**
     * The live browser content/view record the SAME resolver derives from the deterministic inputs.
     * Returned here only as the byte-for-byte proof that the renderer can materialize the record on
     * mount (the mount-and-render closure). The opener never persists it; a denied external-URL
     * policy yields a state WITHOUT a `viewsById[viewId]` entry (fail-closed: a tab, but no
     * navigation).
     */
    seededState: BrowserViewState;
}>;

export type BrowserViewTargetReplacementInput = Readonly<{
    target: BrowserViewTargetV1;
    browserSessionId: string;
    viewId: string;
}>;

/**
 * Matches the launchpad `onOpenTarget` seam so renderers pass it straight through. The optional
 * per-open `options` carry the caller's already-resolved context (the launchpad row resolves its
 * own policy/url with the profile in hand) — the opener prefers those over re-resolving.
 */
export type OpenBrowserViewTarget = (
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
) => void;

/**
 * Canonical resource builder for an in-place browser-view retarget. Unlike a new open, a retarget
 * must preserve the mounted browser session/view identity so the workspace replaces the current
 * durable tab instead of creating a second view. Keeping this beside the new-tab opener makes this
 * module the only production owner allowed to construct `browser-view` tab resources.
 */
export function resolveBrowserViewTargetReplacementTab(
    input: BrowserViewTargetReplacementInput,
): DetailsTab {
    return createBrowserViewDetailsTab(input);
}

const SCOPE_SESSION_ID_PART: Readonly<Record<OpenBrowserTargetScope, string>> = {
    sessionDetails: 'details',
    workspaceDetails: 'details',
    sessionMobile: 'mobile',
};

/**
 * The pure open-options resolver shared by the details renderer's mount-seed and this opener's
 * tab pre-seed. External-URL targets are routed through `evaluateBrowserTargetPolicy`; a denied
 * decision flows into the store as a non-navigating record (the adapter is unavailable), never a
 * blind navigation. Local-service previews resolve their access URL/expiry from the live preview
 * state. (Extracted out of `browserDetailsSurfaceRenderer.tsx` so seed parity is structural.)
 */
export function resolveBrowserTargetOpenOptions(params: Readonly<{
    browserSessionId: string;
    viewId?: string;
    target: BrowserViewTargetV1;
    localServicePreviewState?: LocalServicePreviewState | null;
    browserFeatureDecision?: FeatureDecision | null;
    browserProfile?: BrowserProfileV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    platform: BrowserPlatformV1;
    currentUrl?: string;
    currentUrlExpiresAt?: number;
}>): Parameters<typeof openBrowserTarget>[2] {
    if (params.target.kind === 'externalUrl') {
        const targetPolicyDecision = evaluateBrowserTargetPolicy({
            target: params.target,
            // The in-app browser engines carry no daemon-issued profile; fall back to the host-local
            // default so an opened external URL is evaluated against a usable profile instead of
            // failing closed with `profile_missing` (which would strand the tab on the launchpad).
            profile: resolveLocalBrowserProfile(params.browserProfile),
            browserFeatureDecision: params.browserFeatureDecision,
            allowExternalUrlBrowsing: params.allowExternalUrlBrowsing ?? true,
        });
        return {
            browserSessionId: params.browserSessionId,
            ...(params.viewId ? { viewId: params.viewId } : {}),
            platform: params.platform,
            targetPolicyDecision,
            desktopWebViewAvailability: params.desktopWebViewAvailability,
            ...(params.currentUrl ? { currentUrl: params.currentUrl } : {}),
            ...(params.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: params.currentUrlExpiresAt } : {}),
        };
    }

    if (params.target.kind !== 'localServicePreview' || !params.localServicePreviewState) {
        return {
            browserSessionId: params.browserSessionId,
            ...(params.viewId ? { viewId: params.viewId } : {}),
            platform: params.platform,
            ...(params.currentUrl ? { currentUrl: params.currentUrl } : {}),
            ...(params.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: params.currentUrlExpiresAt } : {}),
        };
    }

    const preview = selectLocalServicePreviewByBrowserTarget(params.localServicePreviewState, params.target);
    const currentUrl = params.currentUrl ?? preview?.accessUrl;
    const previewExpiresAt = typeof preview?.expiresAt === 'number' ? preview.expiresAt : undefined;
    const currentUrlExpiresAt = params.currentUrlExpiresAt ?? previewExpiresAt;
    return {
        browserSessionId: params.browserSessionId,
        ...(params.viewId ? { viewId: params.viewId } : {}),
        platform: params.platform,
        ...(currentUrl ? { currentUrl } : {}),
        ...(currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt } : {}),
    };
}

function readResolvedCurrentUrl(target: BrowserViewTargetV1, options: Parameters<typeof openBrowserTarget>[2]): {
    currentUrl?: string;
    currentUrlExpiresAt?: number;
} {
    const resolved: { currentUrl?: string; currentUrlExpiresAt?: number } = {};
    if (options.currentUrl) {
        resolved.currentUrl = options.currentUrl;
    } else if (target.kind === 'externalUrl') {
        resolved.currentUrl = target.url;
    }
    if (options.currentUrlExpiresAt !== undefined) {
        resolved.currentUrlExpiresAt = options.currentUrlExpiresAt;
    }
    return resolved;
}

/**
 * Pure resolution of an "open target" into BOTH a details-workspace tab and a live content
 * record under one identity. No side effects — the side-effecting opener composes this with
 * `openDetailsTab` + recent tracking.
 *
 * When the caller already resolved the open (the launchpad row resolves its own policy/url with
 * the profile in hand and passes them via `options`), the opener honors that resolution instead
 * of re-evaluating: `options.targetPolicyDecision` short-circuits policy, and the resolved
 * url/expiry/availability/platform are preferred. Otherwise it falls back to the shared
 * `deps`-based resolver so a context-less caller (e.g. the Services binding) still resolves
 * policy/preview-url correctly.
 */
function resolveOpenOptions(
    input: ResolveBrowserViewTargetOpenInput,
    target: BrowserViewTargetV1,
    options: BrowserLaunchpadOpenTargetOptions | undefined,
    browserSessionId: string,
): Parameters<typeof openBrowserTarget>[2] {
    const platform = options?.platform ?? input.platform;
    const desktopWebViewAvailability = options?.desktopWebViewAvailability ?? input.desktopWebViewAvailability;
    return options?.targetPolicyDecision !== undefined
        ? {
            browserSessionId,
            platform,
            targetPolicyDecision: options.targetPolicyDecision,
            desktopWebViewAvailability,
            ...(options.currentUrl ? { currentUrl: options.currentUrl } : {}),
            ...(options.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: options.currentUrlExpiresAt } : {}),
        }
        : resolveBrowserTargetOpenOptions({
            browserSessionId,
            target,
            localServicePreviewState: input.localServicePreviewState,
            browserFeatureDecision: input.browserFeatureDecision,
            browserProfile: input.browserProfile,
            desktopWebViewAvailability,
            allowExternalUrlBrowsing: input.allowExternalUrlBrowsing,
            platform,
            ...(options?.currentUrl ? { currentUrl: options.currentUrl } : {}),
            ...(options?.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: options.currentUrlExpiresAt } : {}),
        });
}

/**
 * Resolve the deterministic open INPUTS — the `browser-view` tab (target + identity) and the
 * resolved current-url seam — WITHOUT materializing a `BrowserViewState`. This is what the
 * side-effecting opener uses, so it does NO throwaway seed compute (B-RC2); the live record is
 * derived once at the renderer from the resource's `target` via the SAME `openBrowserTarget`
 * resolver (DV-OPEN-SEAM).
 */
export function resolveBrowserViewTargetOpenTab(
    input: ResolveBrowserViewTargetOpenInput,
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
): ResolvedBrowserViewTargetOpenTab {
    const browserSessionId = resolveBrowserTargetSurfaceSessionId(SCOPE_SESSION_ID_PART[input.scope], target);
    const viewId = resolveBrowserViewIdForTarget(target);
    const openOptions = resolveOpenOptions(input, target, options, browserSessionId);
    const resolvedUrl = readResolvedCurrentUrl(target, openOptions);
    // The canonical `browser-view` workspace tab — a CONSUMER of the one details-workspace engine.
    // It carries the same `browserSessionId`/`viewId` the renderer derives the content record under,
    // so the tab the host later mounts and the live record agree on identity. The tab seam is
    // URL-free: the live URL/expiry live on the resolver-derived record, not on the resource.
    const tab = createBrowserViewDetailsTab({ target, browserSessionId, viewId });
    return {
        tab,
        browserSessionId,
        viewId,
        ...resolvedUrl,
    };
}

export function resolveBrowserViewTargetOpen(
    input: ResolveBrowserViewTargetOpenInput,
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
): ResolvedBrowserViewTargetOpen {
    const resolvedTab = resolveBrowserViewTargetOpenTab(input, target, options);
    const openOptions = resolveOpenOptions(input, target, options, resolvedTab.browserSessionId);
    // The byte-for-byte proof of materializability: the SAME resolver the renderer uses, derived
    // from the deterministic inputs. The opener does NOT call this — only the renderer materializes
    // the record on mount (DV-OPEN-SEAM).
    const seededState = openBrowserTarget(createBrowserViewState(), target, openOptions);
    return {
        ...resolvedTab,
        seededState,
    };
}

/**
 * Canonical opener: the ONE place that turns a {@link BrowserViewTargetV1} into a details-workspace
 * tab AND a live browser content/view record, atomically, from every caller (launcher rows, the
 * URL box, and the Services "open in browser" seam). The returned `openBrowserViewTarget` matches
 * the launchpad `onOpenTarget` seam so renderers pass it straight through.
 */
export function createOpenBrowserTargetInWorkspace(
    deps: CreateOpenBrowserTargetInWorkspaceDeps,
): OpenBrowserViewTarget {
    const openBrowserViewTarget: OpenBrowserViewTarget = (
        target: BrowserViewTargetV1,
        options?: BrowserLaunchpadOpenTargetOptions,
    ): void => {
        // R-3 (G9): where the platform cannot host an ALLOWED site in-app, the selector resolves to
        // the fulfilled `openExternalTab` outcome and this opener performs it instead of creating a
        // tab. Without it, Windows/Linux/pre-14-macOS get a workspace tab whose `openView` is
        // rejected as `adapter_unavailable` — an empty tab, which is the same dead end R-3 removes
        // on the in-place seam (`BrowserSurfaceHost#navigateCurrentTabInPlace`). Same selector, same
        // fulfilment owner, both callers. Scoped to external sites — nothing else can resolve to an
        // OS-tab handoff, so no other target kind's availability is re-derived here.
        if (target.kind === 'externalUrl') {
            const browserSessionId = resolveBrowserTargetSurfaceSessionId(
                SCOPE_SESSION_ID_PART[deps.scope],
                target,
            );
            const openOptions = resolveOpenOptions(deps, target, options, browserSessionId);
            const selection = selectBrowserTargetAdapter({
                target,
                platform: openOptions.platform,
                targetPolicyDecision: openOptions.targetPolicyDecision,
                desktopWebViewAvailability: openOptions.desktopWebViewAvailability,
            });
            if (selection.ok && selection.outcome === 'openExternalTab') {
                void openBrowserExternalTabSelection(selection);
                return;
            }
        }
        // Tab-only resolution: NO throwaway `seededState` compute (B-RC2 / DV-OPEN-SEAM). The live
        // content record is derived once at the renderer from the resource's `target`.
        const resolved = resolveBrowserViewTargetOpenTab(deps, target, options);
        deps.openDetailsTab(resolved.tab, { intent: 'default' });
        deps.onRememberRecentTarget?.(target);
    };
    return openBrowserViewTarget;
}

/**
 * PR-14 binding helper — the ONE place a Services `LocalServiceLaunchTarget` becomes a
 * `BrowserViewTargetV1`. Reuses the launch target's own `browserTarget`; when absent, builds the
 * canonical `localServicePreview` fallback (mirroring the launchpad builder) from the launch
 * target's own identity. Returns `null` when no openable target can be formed (caller no-ops).
 */
export function mapLocalServiceLaunchTargetToBrowserTarget(
    target: LocalServiceLaunchTargetV1,
): BrowserViewTargetV1 | null {
    if (target.browserTarget) {
        return target.browserTarget;
    }
    const machineId = target.machineId.trim();
    const sessionId = target.sessionId?.trim();
    if (!machineId || !sessionId) {
        return null;
    }
    const title = target.title.trim();
    if (!title) {
        return null;
    }
    const addressLabel = target.subtitle?.trim();
    return {
        kind: 'localServicePreview',
        targetId: target.id,
        sessionId,
        machineId,
        display: {
            title,
            ...(addressLabel ? { addressLabel } : {}),
        },
    };
}

/**
 * The exact value a mount site passes as FP-LSV-HOST-1's `onOpenServiceInBrowser` prop: maps the
 * Services launch target to a browser target, then opens BOTH records through the canonical opener
 * (no-op when the target cannot be mapped).
 */
export function bindServicesOpenInBrowser(
    deps: CreateOpenBrowserTargetInWorkspaceDeps,
): (target: LocalServiceLaunchTargetV1) => void {
    const openBrowserViewTarget = createOpenBrowserTargetInWorkspace(deps);
    return (target: LocalServiceLaunchTargetV1): void => {
        const browserTarget = mapLocalServiceLaunchTargetToBrowserTarget(target);
        if (!browserTarget) {
            return;
        }
        openBrowserViewTarget(browserTarget);
    };
}
