import type {
    BrowserCommandV1,
    BrowserPlatformV1,
    BrowserViewTargetV1,
    FeatureDecision,
} from '@happier-dev/protocol';
import * as React from 'react';

import { BrowserShell } from '@/components/browser/BrowserShell';
import { useBrowserAutomationRuntime } from '@/components/browser/automation/useBrowserAutomationRuntime';
import { useBrowserDiagnosticsRuntime } from '@/components/browser/diagnostics/useBrowserDiagnosticsRuntime';
import type { BrowserLaunchpadOpenTargetOptions } from '@/components/browser/launchpad/BrowserLaunchpad';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import {
    applyBrowserControlEvent,
    browserViewLifecycleEvent,
    dispatchBrowserControlCommand,
    type BrowserControlCommandDispatchResult,
    type BrowserControlCommandEffect,
    type BrowserControlState,
    type BrowserControlViewState,
    type BrowserViewLifecycleSignal,
    type BrowserViewLifecycleTarget,
} from '@/sync/domains/browser/control';
import { resolveExternalUrlTargetFromInput } from '@/sync/domains/browser/shell';
import { registerBrowserRuntimeControlAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import {
    buildCaptureElementRequestFromPickerResult,
    readRegisteredBrowserContextAnnotationAdapter,
} from '@/sync/domains/browser/context';
import type { BrowserDiagnosticsElementPickerResultV1 } from '@happier-dev/protocol';
import { evaluateBrowserTargetPolicy } from '@/sync/domains/browser/policy/evaluate';
import { resolveLocalBrowserProfile } from '@/sync/domains/browser/profiles/localBrowserProfile';
import { selectActiveBrowserView } from '@/sync/domains/browser/shell';
import { resolveBrowserViewIdForTarget } from '@/sync/domains/browser/store';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { useDesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/useDesktopWebViewNativeAvailability';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    executePluginBrowserAction,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/actions';
import {
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { selectBrowserDiagnosticsForView } from '@/sync/domains/browser/diagnostics';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import type { PluginSurfaceHostApi } from '@/components/plugins/surfaces';
import type {
    BrowserPresentationSlotState,
    BrowserSurfaceLifecycleSnapshot,
    BrowserSurfaceRect,
} from './browserSurfaceLifecycle';
import {
    reconcileBrowserPresentationSlots,
} from './browserSurfaceLifecycle';
import { BrowserPluginSurfacePlacements } from './BrowserPluginSurfacePlacements';
import { BrowserSurfaceFallback, type BrowserSurfaceUnavailableReason } from './BrowserSurfaceFallback';
import { BrowserKeepAliveBinder } from './browserPresentationRetention';

type BrowserSurfaceState = Readonly<{
    browserState: BrowserControlState;
    navigationEffect: BrowserControlCommandEffect | null;
}>;

export type BrowserSurfacePolicyDecisionV1 = Readonly<{
    browserEnabled: boolean;
    viewTargetsEnabled: boolean;
    diagnosticsEnabled: boolean;
    contextEnabled: boolean;
    automationEnabled?: boolean;
    recordingEnabled?: boolean;
}>;

export type BrowserSurfaceProductModels = Readonly<{
    browserContext?: React.ComponentProps<typeof BrowserShell>['browserContext'];
    browserDiagnostics?: React.ComponentProps<typeof BrowserShell>['browserDiagnostics'];
    browserAutomation?: React.ComponentProps<typeof BrowserShell>['browserAutomation'];
    browserRecording?: React.ComponentProps<typeof BrowserShell>['browserRecording'];
    browserProfile?: React.ComponentProps<typeof BrowserShell>['browserProfile'];
    supplementalDiagnostics?: React.ComponentProps<typeof BrowserShell>['supplementalDiagnostics'];
}>;

export type BrowserSurfaceViewTargetChange = Readonly<{
    browserSessionId: string;
    viewId: string;
    target: BrowserViewTargetV1;
}>;

function hasBrowserSurfaceProductModelValues(model: BrowserSurfaceProductModels): boolean {
    return model.browserContext !== undefined
        || model.browserDiagnostics !== undefined
        || model.browserAutomation !== undefined
        || model.browserRecording !== undefined
        || model.browserProfile !== undefined
        || model.supplementalDiagnostics !== undefined;
}

export function mergeBrowserSurfaceProductModels(
    primary: BrowserSurfaceProductModels | null | undefined,
    fallback: BrowserSurfaceProductModels | null | undefined,
): BrowserSurfaceProductModels | undefined {
    if (!primary) {
        return fallback && hasBrowserSurfaceProductModelValues(fallback) ? fallback : undefined;
    }
    if (!fallback || !hasBrowserSurfaceProductModelValues(fallback)) {
        return primary;
    }
    const changed = (primary.browserContext === undefined && fallback.browserContext !== undefined)
        || (primary.browserDiagnostics === undefined && fallback.browserDiagnostics !== undefined)
        || (primary.browserAutomation === undefined && fallback.browserAutomation !== undefined)
        || (primary.browserRecording === undefined && fallback.browserRecording !== undefined)
        || (primary.browserProfile === undefined && fallback.browserProfile !== undefined)
        || (primary.supplementalDiagnostics === undefined && fallback.supplementalDiagnostics !== undefined);
    if (!changed) {
        return primary;
    }
    return {
        browserContext: primary.browserContext !== undefined ? primary.browserContext : fallback.browserContext,
        browserDiagnostics: primary.browserDiagnostics !== undefined ? primary.browserDiagnostics : fallback.browserDiagnostics,
        browserAutomation: primary.browserAutomation !== undefined ? primary.browserAutomation : fallback.browserAutomation,
        browserRecording: primary.browserRecording !== undefined ? primary.browserRecording : fallback.browserRecording,
        browserProfile: primary.browserProfile !== undefined ? primary.browserProfile : fallback.browserProfile,
        supplementalDiagnostics: primary.supplementalDiagnostics !== undefined
            ? primary.supplementalDiagnostics
            : fallback.supplementalDiagnostics,
    };
}

function selectNavigationEffect(effects: readonly BrowserControlCommandEffect[]): BrowserControlCommandEffect | null {
    return effects.find((effect) => effect.kind === 'clientLocalNavigation') ?? null;
}

function resolveInitialCurrentUrl(target: BrowserViewTargetV1): string | undefined {
    return target.kind === 'externalUrl' ? target.url : undefined;
}

function resolveUrlOrigin(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

function shouldRetargetActiveViewForAddressNavigation(input: Readonly<{
    view: BrowserControlViewState;
    target: Extract<BrowserViewTargetV1, { kind: 'externalUrl' }>;
}>): boolean {
    const target = input.target;
    if (input.view.target.kind === target.kind) {
        return false;
    }
    const currentOrigin = resolveUrlOrigin(input.view.pendingUrl ?? input.view.currentUrl);
    const targetOrigin = resolveUrlOrigin(target.url);
    if (currentOrigin && targetOrigin && currentOrigin === targetOrigin) {
        return false;
    }
    return true;
}

function decisionEnabled(decision: ReturnType<typeof useFeatureDecision>): boolean {
    return decision?.state === 'enabled';
}

function resolveUnavailableReason(policy: BrowserSurfacePolicyDecisionV1): BrowserSurfaceUnavailableReason | null {
    if (!policy.browserEnabled) return 'disabled';
    if (!policy.viewTargetsEnabled) return 'view_targets_disabled';
    return null;
}

function createPresentationSlot(props: Readonly<{
    presentationSlotId?: string;
    visible?: boolean;
    active?: boolean;
    measuredRect?: BrowserSurfaceRect | null;
}>): BrowserPresentationSlotState | null {
    if (!props.presentationSlotId) {
        return null;
    }
    return {
        presentationSlotId: props.presentationSlotId,
        visible: props.visible === true,
        active: props.active === true,
        measuredRect: props.measuredRect ?? null,
    };
}

function hasRenderableBrowserDiagnostics(
    diagnostics: React.ComponentProps<typeof BrowserShell>['browserDiagnostics'] | null | undefined,
    focusedView: BrowserControlViewState | null | undefined,
): boolean {
    if (!diagnostics || !focusedView) {
        return false;
    }
    if (diagnostics.bridge) {
        return true;
    }
    return selectBrowserDiagnosticsForView(diagnostics.state, {
        browserSessionId: focusedView.browserSessionId,
        viewId: focusedView.viewId,
    }).eventCount > 0;
}

export function BrowserSurfaceHost(props: Readonly<{
    browserSessionId: string;
    platform: BrowserPlatformV1;
    initialBrowserState: BrowserControlState;
    surfaceKey?: string;
    presentationSlotId?: string;
    visible?: boolean;
    active?: boolean;
    measuredRect?: BrowserSurfaceRect | null;
    policy?: BrowserSurfacePolicyDecisionV1;
    launchpadRows?: readonly BrowserLaunchpadRow[];
    launchpadRefreshStatus?: 'idle' | 'refreshing' | 'error';
    launchpadRefreshError?: string | null;
    onOpenTarget?: (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void;
    browserFeatureDecision?: FeatureDecision | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiInteractionEnabled?: boolean;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginBrowserPolicyContext?: PluginUiPolicyEvaluationContext;
    pluginBrowserActionContext?: Readonly<{
        machineId?: string | null;
        serverId?: string | null;
        sessionId?: string | null;
    }>;
    pluginSurfaceHostApi?: PluginSurfaceHostApi;
    simulatorPreviewRuntime?: SimulatorPreviewSurfaceRuntime | null;
    /**
     * A3 (PATCH-01/MC-6): the daemon-command sink for daemon-authoritative views (chromiumSidecar /
     * streamedBrowserSurface). When a navigate/close/setTarget command targets such a view the
     * control reducer emits a `daemonCommand` effect; this routes it to the daemon control owner so
     * the command is actually executed instead of failing closed with `browser_control_route_unavailable`.
     * Supplied by the daemon-backed call site; when absent the daemon-authoritative path stays
     * fail-closed (honest) and only client-local engines (iframe / Wry / RN WebView) operate.
     */
    sendDaemonCommand?: (command: BrowserCommandV1) => void;
    productModels?: BrowserSurfaceProductModels;
    browserContext?: React.ComponentProps<typeof BrowserShell>['browserContext'];
    browserDiagnostics?: React.ComponentProps<typeof BrowserShell>['browserDiagnostics'];
    browserAutomation?: React.ComponentProps<typeof BrowserShell>['browserAutomation'];
    browserRecording?: React.ComponentProps<typeof BrowserShell>['browserRecording'];
    browserProfile?: React.ComponentProps<typeof BrowserShell>['browserProfile'];
    supplementalDiagnostics?: React.ComponentProps<typeof BrowserShell>['supplementalDiagnostics'];
    nowMs?: React.ComponentProps<typeof BrowserShell>['nowMs'];
    testID?: string;
    onLifecycleChange?: (snapshot: BrowserSurfaceLifecycleSnapshot) => void;
    onViewTargetChange?: (input: BrowserSurfaceViewTargetChange) => void;
    /**
     * UX-6 opt-in. When `true` (and a `BrowserPresentationRetentionProvider` is mounted above the
     * router) the surface is hosted by the route-stable webview portal keyed by `presentationSlotId`,
     * so a sidebar toggle / route change repositions the webview instead of remounting (reloading) it.
     * Default `false` keeps the surface rendered inline (current behavior) until a surface — e.g. the
     * desktop / streamed-webview path — flips it on. Inert without a `presentationSlotId`.
     */
    keepAliveAboveRouter?: boolean;
}>): React.ReactElement {
    const browserDecision = useFeatureDecision('browser', { scopeKind: 'runtime' });
    const viewTargetsDecision = useFeatureDecision('browser.viewTargets', { scopeKind: 'runtime' });
    const diagnosticsDecision = useFeatureDecision('browser.diagnostics', { scopeKind: 'runtime' });
    const contextDecision = useFeatureDecision('browser.context', { scopeKind: 'runtime' });
    const automationDecision = useFeatureDecision('browser.automation', { scopeKind: 'runtime' });
    const recordingDecision = useFeatureDecision('browser.recording', { scopeKind: 'runtime' });
    const policy = props.policy ?? {
        browserEnabled: decisionEnabled(browserDecision),
        viewTargetsEnabled: decisionEnabled(viewTargetsDecision),
        diagnosticsEnabled: decisionEnabled(diagnosticsDecision),
        contextEnabled: decisionEnabled(contextDecision),
        automationEnabled: decisionEnabled(automationDecision),
        recordingEnabled: decisionEnabled(recordingDecision),
    };
    const browserFeatureDecision = props.browserFeatureDecision ?? browserDecision;
    const desktopWebViewAvailability = useDesktopWebViewNativeAvailability({
        platform: props.platform,
        availability: props.desktopWebViewAvailability,
    });
    const unavailableReason = resolveUnavailableReason(policy);
    const [surfaceState, setSurfaceState] = React.useState<BrowserSurfaceState>(() => ({
        browserState: props.initialBrowserState,
        navigationEffect: null,
    }));
    const surfaceStateRef = React.useRef<BrowserSurfaceState>(surfaceState);
    const resetKey = props.surfaceKey ?? props.initialBrowserState;
    const previousResetKeyRef = React.useRef(resetKey);
    const previousLifecycleSnapshotRef = React.useRef<BrowserSurfaceLifecycleSnapshot | null>(null);
    const focusedView = selectActiveBrowserView(surfaceState.browserState, props.browserSessionId);
    const logicalViewId = focusedView?.viewId ?? props.browserSessionId;
    // B-RC7 (dark-model wiring, §3.8): construct the already-built live-engine diagnostics runtime
    // for the active view. It is view-bound (it needs `focusedView`), so the host is its natural
    // owner. Only expose it to the shell once it has an actual producer (bridge) or actual daemon
    // events; otherwise web local previews correctly rely on the previewProxy supplemental model
    // instead of rendering a fake "Unavailable" injected diagnostics drawer.
    // Phase 4.2(d): bridge a selected element from the diagnostics picker into a `captureElement`
    // annotation. Resolves the registered annotation adapter for the active view (the same registry
    // the runtime-action front door uses) so the picker selection and annotation are one feature.
    const handleElementPickerAnnotationBridge = React.useCallback((result: BrowserDiagnosticsElementPickerResultV1) => {
        const request = buildCaptureElementRequestFromPickerResult(result);
        if (!request) return;
        const annotationAdapter = readRegisteredBrowserContextAnnotationAdapter({
            browserSessionId: props.browserSessionId,
            viewId: result.viewId,
        });
        void annotationAdapter?.dispatch(request);
    }, [props.browserSessionId]);

    const liveBrowserDiagnostics = useBrowserDiagnosticsRuntime({
        view: focusedView ?? null,
        enabled: policy.diagnosticsEnabled === true,
        daemonSnapshotServerId: props.localServicePreviewServerId,
        onElementPickerResult: handleElementPickerAnnotationBridge,
    });
    const renderableLiveBrowserDiagnostics = hasRenderableBrowserDiagnostics(liveBrowserDiagnostics, focusedView)
        ? liveBrowserDiagnostics
        : null;
    // B-RC7 (dark-model wiring): construct the in-app automation control service for this host and
    // thread it as the `browserAutomation` product model — the single owner the in-iframe automation
    // owner (`WebIframeEngine`) registers against and the runtime action path resolves through.
    // Gated by the host's `browser.automation` decision so it stays dormant until enabled (fail-closed;
    // SEQ-1 GATES default `browser.*` OFF). An explicitly injected automation model still wins (the
    // merge below prefers `props.browserAutomation`).
    const liveBrowserAutomation = useBrowserAutomationRuntime({
        enabled: policy.automationEnabled === true,
    });
    const mergedProductModels = mergeBrowserSurfaceProductModels(props.productModels, {
        browserContext: props.browserContext,
        browserDiagnostics: props.browserDiagnostics ?? renderableLiveBrowserDiagnostics,
        browserAutomation: props.browserAutomation ?? liveBrowserAutomation,
        browserRecording: props.browserRecording,
        browserProfile: props.browserProfile,
        supplementalDiagnostics: props.supplementalDiagnostics,
    });
    // The in-app browser engines carry no daemon-issued profile; back the surface with the
    // host-local default so the launchpad's external-URL rows resolve as allowed (rather than
    // disabled on `profile_missing`) and a typed/opened URL seeds a navigating view. An explicitly
    // supplied profile (e.g. a daemon/session one) still wins.
    const browserProfile = resolveLocalBrowserProfile(mergedProductModels?.browserProfile?.profile ?? null);
    const productModels = mergedProductModels?.browserProfile?.profile === browserProfile
        ? mergedProductModels
        : {
            ...(mergedProductModels ?? {}),
            browserProfile: {
                ...(mergedProductModels?.browserProfile ?? {}),
                profile: browserProfile,
            },
        };
    const pluginBrowserPolicyContext = React.useMemo(
        () => createPluginUiPolicyEvaluationContext(
            {
                platform: props.platform,
                profileMode: browserProfile.storageMode === 'plugin'
                    ? undefined
                    : browserProfile.storageMode,
                data: {
                    plugin: { enabled: true },
                    session: { exists: props.browserSessionId.trim().length > 0 },
                    browser: {
                        exists: focusedView !== null,
                        origin: resolveUrlOrigin(focusedView?.pendingUrl ?? focusedView?.currentUrl),
                    },
                },
            },
            props.pluginBrowserPolicyContext,
        ),
        [
            browserProfile.storageMode,
            focusedView?.currentUrl,
            focusedView?.pendingUrl,
            props.browserSessionId,
            props.platform,
            props.pluginBrowserPolicyContext,
        ],
    );
    const browserDiagnosticsForShell = policy.diagnosticsEnabled
        ? productModels?.browserDiagnostics ?? null
        : null;
    const browserContextForShell = React.useMemo(() => {
        if (!policy.contextEnabled || !productModels?.browserContext) {
            return null;
        }
        const startElementPicker = browserDiagnosticsForShell?.interaction?.onStartElementPicker;
        if (!startElementPicker || productModels.browserContext.onAnnotationSelectElement) {
            return productModels.browserContext;
        }
        return {
            ...productModels.browserContext,
            onAnnotationSelectElement: startElementPicker,
        };
    }, [
        browserDiagnosticsForShell?.interaction?.onStartElementPicker,
        policy.contextEnabled,
        productModels?.browserContext,
    ]);
    const lifecycleSlot = React.useMemo(
        () => createPresentationSlot(props),
        [props.active, props.measuredRect, props.presentationSlotId, props.visible],
    );
    const lifecycleSnapshot = React.useMemo(() => reconcileBrowserPresentationSlots({
        logicalViewId,
        previous: previousLifecycleSnapshotRef.current,
        nextSlots: lifecycleSlot ? [lifecycleSlot] : [],
        hostAvailability: 'available',
    }), [lifecycleSlot, logicalViewId]);
    const runtimeAutomationAdapter = React.useMemo(() => {
        const controlService = policy.automationEnabled === true
            ? productModels?.browserAutomation?.controlService
            : null;
        return controlService ? { controlService } : undefined;
    }, [policy.automationEnabled, productModels?.browserAutomation?.controlService]);
    const applyRuntimeDispatchResult = React.useCallback((result: BrowserControlCommandDispatchResult) => {
        const next = {
            browserState: result.state,
            navigationEffect: selectNavigationEffect(result.effects),
        };
        surfaceStateRef.current = next;
        setSurfaceState(next);
    }, []);

    React.useEffect(() => {
        if (Object.is(previousResetKeyRef.current, resetKey)) {
            return;
        }
        previousResetKeyRef.current = resetKey;
        const next = {
            browserState: props.initialBrowserState,
            navigationEffect: null,
        };
        surfaceStateRef.current = next;
        setSurfaceState(next);
    }, [props.initialBrowserState, resetKey]);

    React.useEffect(() => {
        surfaceStateRef.current = surfaceState;
    }, [surfaceState]);

    React.useEffect(() => {
        previousLifecycleSnapshotRef.current = lifecycleSnapshot;
        props.onLifecycleChange?.(lifecycleSnapshot);
    }, [lifecycleSnapshot, props.onLifecycleChange]);

    React.useEffect(() => {
        if (unavailableReason) {
            return undefined;
        }
        return registerBrowserRuntimeControlAdapter({
            browserSessionId: props.browserSessionId,
            control: {
                readState: () => surfaceStateRef.current.browserState,
                applyDispatchResult: applyRuntimeDispatchResult,
                ...(props.sendDaemonCommand ? { sendDaemonCommand: props.sendDaemonCommand } : {}),
            },
            ...(runtimeAutomationAdapter ? { automation: runtimeAutomationAdapter } : {}),
        });
    }, [applyRuntimeDispatchResult, props.browserSessionId, props.sendDaemonCommand, runtimeAutomationAdapter, unavailableReason]);

    const onCommand = React.useCallback((command: BrowserCommandV1) => {
        setSurfaceState((current) => {
            const result = dispatchBrowserControlCommand(current.browserState, command, {
                desktopWebViewAvailability,
                // A3: route daemon-authoritative commands through the same daemon control sink the
                // runtime-action executor uses, so interactive control and agent-dispatched control
                // share one path (never a parallel one).
                ...(props.sendDaemonCommand ? { sendDaemonCommand: props.sendDaemonCommand } : {}),
            });
            const next = {
                browserState: result.state,
                navigationEffect: selectNavigationEffect(result.effects),
            };
            surfaceStateRef.current = next;
            return next;
        });
    }, [desktopWebViewAvailability, props.sendDaemonCommand]);

    // B-2 cause-2: in-app render engines (iframe / RN WebView / Wry-desktop child view) own their
    // own page-load lifecycle. They feed it back here through the SAME canonical
    // `applyBrowserControlEvent` path the daemon engines use, so a URL-bearing open (seeded as
    // `loading` per B-2 cause-1) transitions to `ready`/`failed` instead of spinning forever. The
    // engine never reaches into the reducer directly — it only emits a normalized lifecycle signal.
    const applyViewLifecycleSignal = React.useCallback((
        target: BrowserViewLifecycleTarget,
        signal: BrowserViewLifecycleSignal,
    ) => {
        const event = browserViewLifecycleEvent(target, signal);
        if (!event) {
            return;
        }
        setSurfaceState((current) => {
            const browserState = applyBrowserControlEvent(current.browserState, event);
            if (browserState === current.browserState) {
                return current;
            }
            const next = {
                browserState,
                navigationEffect: current.navigationEffect,
            };
            surfaceStateRef.current = next;
            return next;
        });
    }, []);

    // OWNER-NAV (DV-NAV): navigate the CURRENT browser tab in place — an in-place `openView` that
    // materializes / retargets the view in THIS host. This is the canonical current-tab seam the
    // launchpad/new-tab URL entry uses; it NEVER spawns a sibling workspace tab. Only EXTERNAL
    // surfaces (Services rows, session-header button) create a new tab via `props.onOpenTarget`.
    const navigateCurrentTabInPlace = React.useCallback((target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => {
        // When the caller did not pre-resolve a policy decision (e.g. the launchpad URL-entry box,
        // which only forwards the platform), evaluate the external-URL policy here against the
        // resolved host profile so a typed URL seeds a navigating view instead of failing closed.
        const targetPolicyDecision = options?.targetPolicyDecision
            ?? (target.kind === 'externalUrl'
                ? evaluateBrowserTargetPolicy({
                    target,
                    profile: browserProfile,
                    browserFeatureDecision,
                    allowExternalUrlBrowsing: props.allowExternalUrlBrowsing ?? true,
                })
                : undefined);

        const viewId = resolveBrowserViewIdForTarget(target);
        const result = dispatchBrowserControlCommand(surfaceStateRef.current.browserState, {
            kind: 'openView',
            commandId: `browser_command:${viewId}:open:${Date.now()}`,
            browserSessionId: props.browserSessionId,
            viewId,
            target,
            platform: options?.platform ?? props.platform,
            currentUrl: options?.currentUrl ?? resolveInitialCurrentUrl(target),
            currentUrlExpiresAt: options?.currentUrlExpiresAt,
            focus: true,
        }, {
            targetPolicyDecision,
            desktopWebViewAvailability: options?.desktopWebViewAvailability ?? desktopWebViewAvailability,
        });
        const next = {
            browserState: result.state,
            navigationEffect: selectNavigationEffect(result.effects),
        };
        surfaceStateRef.current = next;
        setSurfaceState(next);
        if (result.state.viewsById[viewId]) {
            props.onViewTargetChange?.({
                browserSessionId: props.browserSessionId,
                viewId,
                target,
            });
        }
    }, [
        browserFeatureDecision,
        browserProfile,
        desktopWebViewAvailability,
        props.allowExternalUrlBrowsing,
        props.browserSessionId,
        props.onViewTargetChange,
        props.platform,
    ]);

    const navigateActiveViewInPlace = React.useCallback((input: Readonly<{
        view: BrowserControlViewState;
        url: string;
        platform: BrowserPlatformV1;
    }>) => {
        const target = resolveExternalUrlTargetFromInput(input.url);
        if (
            !target
            || target.kind !== 'externalUrl'
            || !shouldRetargetActiveViewForAddressNavigation({ view: input.view, target })
        ) {
            return false;
        }
        const targetPolicyDecision = evaluateBrowserTargetPolicy({
            target,
            profile: browserProfile,
            browserFeatureDecision,
            allowExternalUrlBrowsing: props.allowExternalUrlBrowsing ?? true,
        });
        const result = dispatchBrowserControlCommand(surfaceStateRef.current.browserState, {
            kind: 'setTarget',
            commandId: `browser_command:${input.view.viewId}:setTarget:${Date.now()}`,
            browserSessionId: input.view.browserSessionId,
            viewId: input.view.viewId,
            target,
            currentUrl: target.url,
        }, {
            targetPolicyDecision,
            desktopWebViewAvailability,
        });
        if (result.effects.some((effect) => effect.kind === 'commandRejected')) {
            return false;
        }
        const next = {
            browserState: result.state,
            navigationEffect: selectNavigationEffect(result.effects),
        };
        surfaceStateRef.current = next;
        setSurfaceState(next);
        props.onViewTargetChange?.({
            browserSessionId: input.view.browserSessionId,
            viewId: input.view.viewId,
            target,
        });
        return true;
    }, [
        browserFeatureDecision,
        browserProfile,
        desktopWebViewAvailability,
        props.allowExternalUrlBrowsing,
        props.onViewTargetChange,
    ]);

    const onOpenTarget = React.useCallback((target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => {
        if (props.onOpenTarget) {
            props.onOpenTarget(target, options);
            return;
        }
        navigateCurrentTabInPlace(target, options);
    }, [navigateCurrentTabInPlace, props.onOpenTarget]);
    const onPluginBrowserAction = React.useCallback<NonNullable<React.ComponentProps<typeof BrowserShell>['onPluginBrowserAction']>>(
        (action, input) => {
            void executePluginBrowserAction({
                action,
                generation: props.pluginBrowserProjection?.generation ?? null,
                machineId: props.pluginBrowserActionContext?.machineId,
                serverId: props.pluginBrowserActionContext?.serverId,
                sessionId: props.pluginBrowserActionContext?.sessionId,
                input,
                policyContext: pluginBrowserPolicyContext,
            });
        },
        [
            props.pluginBrowserActionContext?.machineId,
            props.pluginBrowserActionContext?.serverId,
            props.pluginBrowserActionContext?.sessionId,
            props.pluginBrowserProjection?.generation,
            pluginBrowserPolicyContext,
        ],
    );

    if (unavailableReason) {
        return (
            <BrowserSurfaceFallback
                reason={unavailableReason}
                testID={`${props.testID ?? 'browser-surface'}-unavailable-${unavailableReason}`}
            />
        );
    }

    return (
        <BrowserKeepAliveBinder
            slotId={props.presentationSlotId ?? props.browserSessionId}
            visible={props.visible ?? true}
            enabled={props.keepAliveAboveRouter === true && typeof props.presentationSlotId === 'string'}
        >
            <BrowserShell
                browserSessionId={props.browserSessionId}
                viewId={focusedView?.viewId ?? null}
                platform={props.platform}
                state={surfaceState.browserState}
                onCommand={onCommand}
                onViewLifecycle={applyViewLifecycleSignal}
                launchpadRows={props.launchpadRows}
                launchpadRefreshStatus={props.launchpadRefreshStatus}
                launchpadRefreshError={props.launchpadRefreshError}
                onOpenTarget={onOpenTarget}
                onNavigateInPlace={navigateCurrentTabInPlace}
                onNavigateActiveViewInPlace={navigateActiveViewInPlace}
                browserFeatureDecision={browserFeatureDecision}
                desktopWebViewAvailability={desktopWebViewAvailability}
                allowExternalUrlBrowsing={props.allowExternalUrlBrowsing}
                localServicePreviewState={props.localServicePreviewState}
                localServicePreviewServerId={props.localServicePreviewServerId}
                pluginUiProjection={props.pluginUiProjection}
                pluginUiInteractionEnabled={props.pluginUiInteractionEnabled}
                pluginBrowserProjection={props.pluginBrowserProjection}
                pluginBrowserPolicyContext={pluginBrowserPolicyContext}
                onPluginBrowserAction={props.pluginBrowserActionContext?.machineId ? onPluginBrowserAction : undefined}
                simulatorPreviewRuntime={props.simulatorPreviewRuntime}
                browserContext={browserContextForShell}
                browserDiagnostics={browserDiagnosticsForShell}
                browserAutomation={policy.automationEnabled === true ? productModels?.browserAutomation : null}
                browserRecording={policy.recordingEnabled === true ? productModels?.browserRecording : null}
                browserProfile={productModels?.browserProfile}
                navigationEffect={surfaceState.navigationEffect}
                supplementalDiagnostics={policy.diagnosticsEnabled ? productModels?.supplementalDiagnostics : null}
                nowMs={props.nowMs}
                testID={props.testID}
            />
            <BrowserPluginSurfacePlacements
                focusedTarget={focusedView?.target}
                platform={props.platform}
                pluginUiProjection={props.pluginUiProjection}
                projectionInteractionEnabled={props.pluginUiInteractionEnabled}
                localServicePreviewState={props.localServicePreviewState}
                localServicePreviewServerId={props.localServicePreviewServerId}
                hostApi={props.pluginSurfaceHostApi}
                nowMs={props.nowMs}
                testID={props.testID}
            />
        </BrowserKeepAliveBinder>
    );
}
