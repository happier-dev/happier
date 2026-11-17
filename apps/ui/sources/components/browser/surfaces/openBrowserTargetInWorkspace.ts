import type {
    BrowserPlatformV1} from '@happier-dev/protocol/browser/view/v1';
import type {
    BrowserProfileV1} from '@happier-dev/protocol/browser/profile/v1';
import type {
    BrowserViewTargetV1} from '@happier-dev/protocol/browser/target/v1';
import type {
    FeatureDecision} from '@happier-dev/protocol/features/decision';
import type {
    LocalServiceLaunchTargetV1} from '@happier-dev/protocol/local/services/launcher/v1';
import type {
    ActionExecuteResult} from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
    ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import type {
    ActionId,
} from '@happier-dev/protocol/actions/actionIds';
import { BrowserCommandDispatchResultV1Schema, BrowserWorkspaceOpenResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createBrowserRuntimeActionExecutor, type BrowserRuntimeWorkspaceOpeningAdapter } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import {
    claimBrowserRuntimeWorkspaceOpenRegion,
    readRegisteredBrowserRuntimeControlAdapter,
    readRegisteredBrowserRuntimeAutomationAdapter,
    type BrowserWorkspaceOpenerRegion,
} from '@/sync/domains/browser/actions/runtimeControlRegistry';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import type { BrowserLaunchpadOpenTargetOptions } from '@/components/browser/launchpad/BrowserLaunchpad';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import {
    openBrowserExternalTabSelection,
    selectBrowserTargetAdapter,
    type BrowserOpenEngineOverride,
} from '@/sync/domains/browser/adapters/selection';
import { evaluateBrowserTargetPolicy } from '@/sync/domains/browser/policy/evaluate';
import { resolveLocalBrowserProfile } from '@/sync/domains/browser/profiles/localBrowserProfile';
import {
    createBrowserViewState,
    openBrowserTarget,
    resolveBrowserViewIdForTarget,
    resolveBrowserDaemonStreamTarget,
} from '@/sync/domains/browser/store';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import { listBrowserDaemonViewsViaMachineRpc } from '@/sync/domains/browser/control/machineRpc';
import type { BrowserViewState } from '@/sync/domains/browser/types';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { selectLocalServicePreviewByBrowserTarget } from '@/sync/domains/local/services/preview/store';
import { getLocalServicePreviewState } from '@/sync/domains/local/services/preview/sharedStore';
import { resolveLocalServiceBrowserTarget, type LocalServiceBrowserOpenTarget } from '@/sync/domains/local/services/preview/resolveLaunchTarget';
import type { BrowserAddressFacts } from '@/sync/domains/browser/actions/address';

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
    options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview'; origin?: BrowserWorkspaceOpenerRegion }>,
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
}> & BrowserAddressFacts;

export type CreateOpenBrowserTargetInWorkspaceDeps = ResolveBrowserViewTargetOpenInput & Readonly<{
    scopeId: string;
    accountLifetime: ServerAccountScopeLifetime | null;
    /** Originating workspace cancellation, including an approval wait. */
    readonly signal?: AbortSignal;
    /** Latest owning workspace facts, read only after Action admission. */
    readOpenFacts?: () => ResolveBrowserViewTargetOpenInput;
    isCurrent?: () => boolean;
    actionExecute?: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
    openDetailsTab: OpenDetailsTab;
    /** The pane column this caller sits in, read at open time; lent to the scope's opener. */
    readOpenerRegion?: () => BrowserWorkspaceOpenerRegion | null;
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
    currentUrl?: string | null;
    engineOverride?: BrowserOpenEngineOverride;
}>;

/**
 * Matches the launchpad `onOpenTarget` seam so renderers pass it straight through. The optional
 * per-open `options` are presentation hints. The admitted opener re-resolves current owning
 * workspace policy and URL facts so UI and Agent callers cannot override navigation authority.
 */
export type OpenBrowserViewTarget = (
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
) => void | Promise<ActionExecuteResult>;

export type BrowserWorkspaceTargetOpener = ((
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
) => Promise<ActionExecuteResult>) & Readonly<{
    runtimeAdapter: BrowserRuntimeWorkspaceOpeningAdapter;
}>;

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
    engineOverride?: BrowserOpenEngineOverride;
}>): Parameters<typeof openBrowserTarget>[2] {
    const engineOptions = params.engineOverride ? { engineOverride: params.engineOverride } : {};
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
            ...engineOptions,
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
            ...engineOptions,
            desktopWebViewAvailability: params.desktopWebViewAvailability,
            ...(params.currentUrl ? { currentUrl: params.currentUrl } : {}),
            ...(params.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: params.currentUrlExpiresAt } : {}),
        };
    }

    const preview = selectLocalServicePreviewByBrowserTarget(params.localServicePreviewState, params.target);
    const currentUrl = params.currentUrl && preview?.accessUrl
        ? new URL(params.currentUrl, preview.accessUrl).href
        : params.currentUrl ?? preview?.accessUrl;
    const previewExpiresAt = typeof preview?.expiresAt === 'number' ? preview.expiresAt : undefined;
    const currentUrlExpiresAt = params.currentUrlExpiresAt ?? previewExpiresAt;
    return {
        browserSessionId: params.browserSessionId,
        ...(params.viewId ? { viewId: params.viewId } : {}),
        platform: params.platform,
        ...engineOptions,
        desktopWebViewAvailability: params.desktopWebViewAvailability,
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
            ...(options.engineOverride ? { engineOverride: options.engineOverride } : {}),
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
            ...(options?.engineOverride ? { engineOverride: options.engineOverride } : {}),
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
    const tab = createBrowserViewDetailsTab({ target, browserSessionId, viewId,
        ...(options?.engineOverride ? { engineOverride: options.engineOverride } : {}) });
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

let workspaceOpenSequence = 0;

/**
 * Canonical admitted workspace opener. A new tab materializes at its renderer;
 * a retained tab consumes navigation through its existing mounted runtime owner.
 */
export function createOpenBrowserTargetInWorkspace(
    deps: CreateOpenBrowserTargetInWorkspaceDeps,
): BrowserWorkspaceTargetOpener {
    const unavailable = (): ActionExecuteResult => ({ ok: false, errorCode: 'runtime_action_disabled',
        error: 'runtime_action_disabled:browser:browser_view_unavailable' });
    const runtimeAdapter: BrowserRuntimeWorkspaceOpeningAdapter = {
        scopeId: deps.scopeId,
        accountLifetime: deps.accountLifetime,
        readAddressFacts: () => deps.readOpenFacts?.() ?? deps,
        open: async (request, context, presentation) => {
            const current = () => deps.accountLifetime?.isCurrent() === true
                && deps.isCurrent?.() !== false && !context.signal?.aborted;
            if (!current()) return unavailable();
            const target = request.target;
            const workspaceFacts = deps.readOpenFacts?.() ?? deps;
            // Details can own presentation without mounting a preview feed. An
            // explicit open still reads the registration already published by
            // the Service action from its canonical Machine/Home store.
            const facts = target.kind === 'localServicePreview' && !workspaceFacts.localServicePreviewState
                ? { ...workspaceFacts, localServicePreviewState: getLocalServicePreviewState({
                    machineId: target.machineId, serverId: deps.accountLifetime?.scope.serverId,
                    accountId: deps.accountLifetime?.scope.accountId,
                }) } : workspaceFacts;
            const resolved = resolveBrowserViewTargetOpenTab(facts, target, { engineOverride: request.engineOverride, platform: facts.platform });
            // Launchpad policy/URL options are presentation hints, not authority. UI and Agent
            // resolve the same current workspace facts after approval, at this one selector.
            const openOptions = resolveOpenOptions(facts, target, undefined, resolved.browserSessionId);
            const selection = selectBrowserTargetAdapter({
                target,
                engineOverride: request.engineOverride,
                platform: openOptions.platform,
                targetPolicyDecision: openOptions.targetPolicyDecision,
                desktopWebViewAvailability: openOptions.desktopWebViewAvailability,
                managedBrowserAvailable: presentation?.managedBrowserAvailable === true
                    && Boolean(facts.localServiceAddressScope?.machineId && facts.localServiceAddressScope.sessionId),
            });
            if (!selection.ok) return { ok: false, errorCode: 'runtime_action_disabled',
                error: 'runtime_action_disabled:browser:browser_adapter_unavailable' };
            if (!current()) return unavailable();
            if (selection.outcome === 'openExternalTab') {
                if (!await openBrowserExternalTabSelection(selection)) return { ok: false,
                    errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_adapter_unavailable' };
            } else if (selection.outcome === 'managedBrowser') {
                const route = facts.localServiceAddressScope;
                if (!route?.machineId || !route.sessionId || !presentation?.executeControl) return unavailable();
                const opened = await presentation.executeControl({ actionId: 'browser.view.open', input: {
                    kind: 'openView', commandId: request.commandId, browserSessionId: route.sessionId,
                    viewId: resolved.viewId, target, platform: openOptions.platform, currentUrl: selection.url,
                    ...(request.engineOverride ? { engineOverride: request.engineOverride } : {}), focus: true,
                }, context: { ...context, defaultSessionId: route.sessionId,
                    externalActionTarget: { kind: 'machine', machineId: route.machineId } } });
                const dispatched = BrowserCommandDispatchResultV1Schema.safeParse(opened);
                if (!dispatched.success || dispatched.data.status !== 'dispatched') return opened;
                if (!current()) return unavailable();
                const discovery = await listBrowserDaemonViewsViaMachineRpc({ machineId: route.machineId,
                    serverId: deps.accountLifetime!.scope.serverId, accountId: deps.accountLifetime!.scope.accountId,
                    browserSessionId: route.sessionId, signal: context.signal });
                if (!current()) return unavailable();
                if (!discovery.ok) return { ok: false, errorCode: 'runtime_action_disabled',
                    error: `runtime_action_disabled:browser:${discovery.reason}` };
                const daemonView = discovery.views.find(view => view.viewId === resolved.viewId);
                const streamTarget = daemonView ? resolveBrowserDaemonStreamTarget(daemonView) : null;
                if (!streamTarget) return unavailable();
                const streamTab = createBrowserViewDetailsTab({ target: streamTarget, engineOverride: request.engineOverride });
                // The pane still owns the same logical page; daemon discovery owns its content identity.
                deps.openDetailsTab({ ...streamTab, key: resolved.tab.key }, { intent: 'default',
                    ...(presentation.openerRegion ? { origin: presentation.openerRegion } : {}) });
                deps.onRememberRecentTarget?.(target);
            } else {
                const control = readRegisteredBrowserRuntimeControlAdapter(resolved.browserSessionId, resolved.viewId, deps.accountLifetime?.scope);
                const view = control?.readState()?.viewsById[resolved.viewId];
                // Reopening an existing tab is an explicit navigation intent. Its mounted
                // engine owns the current document, so updating the tab alone cannot return
                // a page that has navigated away to the Service's freshly resolved address.
                const retryPreview = target.kind === 'localServicePreview' && view?.loadingState === 'failed';
                const switchToEmbedded = request.engineOverride === 'embedded' && isDaemonAuthoritativeBrowserView(view);
                const returnToTarget = view && (switchToEmbedded || retryPreview || view.target.kind !== target.kind || view.target.targetId !== target.targetId
                    || (resolved.currentUrl
                        ? view.currentUrl !== resolved.currentUrl || view.pendingUrl !== null
                        : target.kind === 'localServicePreview' && (view.currentUrl !== null || view.pendingUrl !== null)));
                if (control && view && returnToTarget) {
                    const dispatch = createBrowserRuntimeActionExecutor({ control,
                        automation: readRegisteredBrowserRuntimeAutomationAdapter(resolved.browserSessionId, resolved.viewId, deps.accountLifetime?.scope) ?? undefined });
                    const reopen = { actionId: 'browser.view.open', input: {
                        kind: 'openView', commandId: request.commandId, browserSessionId: resolved.browserSessionId,
                        viewId: resolved.viewId, target, platform: openOptions.platform,
                        ...(request.engineOverride ? { engineOverride: request.engineOverride } : {}),
                        currentUrl: resolved.currentUrl, currentUrlExpiresAt: resolved.currentUrlExpiresAt, focus: true,
                    } } as const;
                    // A failed retained preview also owns a latched access refusal. Reuse
                    // Reload's existing admission reset; healthy opens do not reacquire it.
                    const reload = { actionId: 'browser.reload', input: { kind: 'reload',
                        commandId: `${request.commandId}:reload`, browserSessionId: resolved.browserSessionId,
                        viewId: resolved.viewId } } as const;
                    for (const command of retryPreview ? [reopen, reload] : [reopen]) {
                        const result = await dispatch({ ...command, context });
                        const failure = ActionExecuteFailureSchema.safeParse(result);
                        if (failure.success) return failure.data;
                        const dispatched = BrowserCommandDispatchResultV1Schema.safeParse(result);
                        if (!dispatched.success) return unavailable();
                        if (dispatched.data.status === 'failed') return { ok: false,
                            errorCode: dispatched.data.error.code, error: dispatched.data.error.message,
                            details: { retryable: dispatched.data.error.retryable } };
                        if (!current()) return unavailable();
                    }
                }
                deps.openDetailsTab(resolved.tab, { intent: 'default',
                    ...(presentation?.openerRegion ? { origin: presentation.openerRegion } : {}) });
                deps.onRememberRecentTarget?.(target);
            }
            return BrowserWorkspaceOpenResultV1Schema.parse({ v: 1, commandId: request.commandId,
                status: 'dispatched', adapterKind: selection.adapterKind, events: [],
                outcome: selection.outcome === 'openExternalTab' ? 'externalTab' : 'workspaceTab' });
        },
    };
    const open = async (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions): Promise<ActionExecuteResult> => {
        if (!deps.accountLifetime?.isCurrent() || deps.isCurrent?.() === false || deps.signal?.aborted) return unavailable();
        const execute = deps.actionExecute ?? (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
        const commandId = `workspace-open:${Date.now()}:${++workspaceOpenSequence}`;
        // The scope's opener decides the open; Details still learns which column it came from.
        const region = deps.readOpenerRegion?.() ?? null;
        const releaseClaim = region ? claimBrowserRuntimeWorkspaceOpenRegion({ scope: deps.accountLifetime.scope,
            scopeId: runtimeAdapter.scopeId, commandId, region }) : () => {};
        try {
            return await execute('browser.workspace.open', { scopeId: runtimeAdapter.scopeId, commandId, target,
                ...(options?.engineOverride ? { engineOverride: options.engineOverride } : {}) },
                { surface: 'ui', authority: 'present_user', serverId: deps.accountLifetime?.scope.serverId,
                    expectedAccountId: deps.accountLifetime?.scope.accountId, signal: deps.signal });
        } finally {
            releaseClaim();
        }
    };
    return Object.assign(open, { runtimeAdapter });
}

/**
 * Read the launcher's existing browser projection without inventing preview identity.
 * Open and Share resolve registration through `resolveLocalServiceBrowserTarget`.
 */
export function mapLocalServiceLaunchTargetToBrowserTarget(
    target: LocalServiceLaunchTargetV1,
): BrowserViewTargetV1 | null {
    return target.browserTarget ?? null;
}

/**
 * The exact value a mount site passes as FP-LSV-HOST-1's `onOpenServiceInBrowser` prop: maps the
 * Services launch target to a browser target, then admits it through the canonical opener.
 * Returns the action outcome; admission does not claim the preview page has loaded.
 */
export type ServicesOpenInBrowserResult =
    | Readonly<{ status: 'succeeded' }>
    | Readonly<{ status: 'denied'; reasonCode: string }>
    | Extract<ActionExecuteResult, { ok: false }>
    | ActionApprovalRequestCreatedResult;

type ServicesOpenInBrowserDeps = Readonly<{
    onOpenTarget: OpenBrowserViewTarget;
    platform: BrowserPlatformV1;
    actionExecute?: CreateOpenBrowserTargetInWorkspaceDeps['actionExecute'];
}> & Readonly<{
    serverId?: string | null;
    sessionId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    credentialKey?: string;
}>;

export function bindServicesOpenInBrowser(
    deps: ServicesOpenInBrowserDeps,
): (target: LocalServiceBrowserOpenTarget) => Promise<ServicesOpenInBrowserResult> {
    const openBrowserViewTarget = deps.onOpenTarget;
    return async (target: LocalServiceBrowserOpenTarget): Promise<ServicesOpenInBrowserResult> => {
        const resolved = await resolveLocalServiceBrowserTarget(target, {
            serverId: deps.serverId, sessionId: deps.sessionId, accountLifetime: deps.accountLifetime,
            ...(deps.actionExecute ? { execute: async (request, context) => {
                const result = await deps.actionExecute!('localServices.preview.openOrCreate', request, context);
                return result.ok ? result.result : result;
            } } : {}),
        });
        if (!('status' in resolved) || resolved.status !== 'succeeded') return resolved;
        const opened = await openBrowserViewTarget(resolved.target, resolved.target.kind === 'localServicePreview'
            ? { platform: deps.platform, ...(resolved.currentUrl ? { currentUrl: resolved.currentUrl } : {}) }
            : undefined);
        if (opened && !opened.ok) return opened;
        const approval = opened && ActionApprovalRequestCreatedResultSchema.safeParse(opened.result);
        if (approval && approval.success) return approval.data;
        return { status: 'succeeded' };
    };
}
