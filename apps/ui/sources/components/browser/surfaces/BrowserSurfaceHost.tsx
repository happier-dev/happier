import type {
    BrowserCommandV1,
    BrowserEventV1,
    BrowserPlatformV1,
    BrowserViewTargetV1,
    FeatureDecision,
} from '@happier-dev/protocol';
import * as React from 'react';

import { BrowserShell } from '@/components/browser/BrowserShell';
import type { BrowserDaemonControlCommandSender } from '@/sync/domains/browser/control/machineRpc';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import { useBrowserAutomationRuntime } from '@/components/browser/automation/useBrowserAutomationRuntime';
import { useBrowserStreamedSurfaceRuntime } from '@/components/browser/streamed/useBrowserStreamedSurfaceRuntime';
import { useBrowserDiagnosticsRuntime } from '@/components/browser/diagnostics/useBrowserDiagnosticsRuntime';
import type { BrowserLaunchpadOpenTargetOptions } from '@/components/browser/launchpad/BrowserLaunchpad';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import {
    applyBrowserControlEvent,
    browserViewLifecycleEvent,
    refreshBrowserNativeViewCaptureCapabilities,
    type BrowserControlCommandDispatchResult,
    type BrowserControlCommandEffect,
    type BrowserControlState,
    type BrowserControlViewState,
    type BrowserViewLifecycleSignal,
    type BrowserViewLifecycleTarget,
} from '@/sync/domains/browser/control';
import { resolveExternalUrlTargetFromInput } from '@/sync/domains/browser/shell';
import { registerBrowserRuntimeControlAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import type { BrowserRuntimeControlAdapter } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import { browserControlActionId } from '@/sync/domains/browser/actions/controlActionId';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import {
    buildCaptureElementRequestFromPickerResult,
    readRegisteredBrowserContextAnnotationAdapter,
} from '@/sync/domains/browser/context';
import type { BrowserDiagnosticsElementPickerResultV1 } from '@happier-dev/protocol';
import { evaluateBrowserTargetPolicy } from '@/sync/domains/browser/policy/evaluate';
import { resolveLocalBrowserProfile } from '@/sync/domains/browser/profiles/localBrowserProfile';
import { selectActiveBrowserView } from '@/sync/domains/browser/shell';
import { resolveBrowserViewIdForTarget } from '@/sync/domains/browser/store';
import { useSession } from '@/sync/domains/state/storage';
import { useSessionCompletedBrowserActionKey } from '@/sync/store/hooks';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { useDesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/useDesktopWebViewNativeAvailability';
import { useDesktopBrowserRecordingReverseCaptureHandler } from '@/sync/domains/browser/recording/reverseCaptureAvailability';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    createPluginUiProjectedActionResolver,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    executePluginBrowserAction,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/actions';
import {
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { selectBrowserDiagnosticsEventCount } from '@/sync/domains/browser/diagnostics';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
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
import { RetainedPresentationSlotBinder } from '@/components/ui/presentation/retainedPresentationSlots';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

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
    return diagnostics.hasRenderableDiagnostics ?? selectBrowserDiagnosticsEventCount(diagnostics.state, {
        browserSessionId: focusedView.browserSessionId,
        viewId: focusedView.viewId,
    }) > 0;
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
    pluginAccountLifetime?: ServerAccountScopeLifetime | null;
    pluginUiInteractionEnabled?: boolean;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginBrowserPolicyContext?: PluginUiPolicyEvaluationContext;
    pluginBrowserActionContext?: Readonly<{
        machineId?: string | null;
        serverId?: string | null;
        sessionId?: string | null;
    }>;
    simulatorPreviewRuntime?: SimulatorPreviewSurfaceRuntime | null;
    /**
     * A3 (PATCH-01/MC-6): the daemon-command sink for daemon-authoritative views (chromiumSidecar /
     * streamedBrowserSurface). When a navigate/close/setTarget command targets such a view the
     * control reducer emits a `daemonCommand` effect; this routes it to the daemon control owner so
     * the command is actually executed instead of failing closed with `browser_control_route_unavailable`.
     * Supplied by the daemon-backed call site; when absent the daemon-authoritative path stays
     * fail-closed (honest) and only client-local engines (iframe / Wry / RN WebView) operate.
     */
    sendDaemonCommand?: BrowserDaemonControlCommandSender;
    /** Stream/native transport events use the same reducer as command response events. */
    subscribeBrowserEvents?: (listener: (event: BrowserEventV1) => void) => () => void;
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
    const currentUiContextReader = useOptionalCurrentUiContextReader();
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
    const nativeViewCaptureHandlerRegistered = useDesktopBrowserRecordingReverseCaptureHandler(props.pluginBrowserActionContext?.machineId);
    const [surfaceState, setSurfaceState] = React.useState<BrowserSurfaceState>(() => ({
        browserState: props.initialBrowserState,
        navigationEffect: null,
    }));
    const surfaceStateRef = React.useRef<BrowserSurfaceState>(surfaceState);
    React.useEffect(() => {
        setSurfaceState(current => {
            const browserState = refreshBrowserNativeViewCaptureCapabilities(current.browserState, {
                desktopWebViewAvailability, nativeViewCaptureHandlerRegistered,
            });
            if (browserState === current.browserState) return current;
            const next = { ...current, browserState };
            surfaceStateRef.current = next;
            return next;
        });
    }, [desktopWebViewAvailability, nativeViewCaptureHandlerRegistered, surfaceState.browserState]);
    const resetKey = props.surfaceKey ?? props.initialBrowserState;
    const previousResetKeyRef = React.useRef(resetKey);
    const mountedRef = React.useRef(true);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    const previousLifecycleSnapshotRef = React.useRef<BrowserSurfaceLifecycleSnapshot | null>(null);
    const presenceSessionId = props.pluginBrowserActionContext?.sessionId ?? null;
    const presenceServerId = props.pluginBrowserActionContext?.serverId ?? null;
    const session = useSession(presenceSessionId ?? '', presenceServerId);
    const discoveryRefreshKey = useSessionCompletedBrowserActionKey(presenceSessionId ?? '', {
        enabled: Boolean(presenceSessionId && session && props.visible !== false && policy.viewTargetsEnabled),
    });
    const focusedView = selectActiveBrowserView(surfaceState.browserState, props.browserSessionId)
        ?? (presenceSessionId ? selectActiveBrowserView(surfaceState.browserState, presenceSessionId) : null);
    const applyDaemonEvents = React.useCallback((events: readonly BrowserEventV1[]) => {
        setSurfaceState(current => {
            const browserState = events.reduce((state, event) => {
                // Discovery refreshes authoritative snapshots without replacing an already live
                // content record (and losing its controller or viewer continuity).
                if (event.kind === 'viewOpened' && state.viewsById[event.viewId]?.browserSessionId === event.browserSessionId) return state;
                return applyBrowserControlEvent(state, event);
            }, current.browserState);
            if (browserState === current.browserState) return current;
            const next = { ...current, browserState };
            surfaceStateRef.current = next;
            return next;
        });
    }, []);
    const receiveBrowserEvent = React.useCallback((event: BrowserEventV1) => applyDaemonEvents([event]), [applyDaemonEvents]);
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
        automationEnabled: policy.automationEnabled === true,
        daemonSnapshotServerId: props.localServicePreviewServerId,
        onElementPickerResult: handleElementPickerAnnotationBridge,
    });
    const renderableLiveBrowserDiagnostics = hasRenderableBrowserDiagnostics(liveBrowserDiagnostics, focusedView)
        ? liveBrowserDiagnostics
        : null;
    // B-RC7 (dark-model wiring): construct the in-app automation control service for this host and
    // thread it as the `browserAutomation` product model — the single owner the in-iframe automation
    // owner (`WebIframeEngine`) registers against and the runtime action path resolves through.
    // Uses the existing product decision independently of diagnostics presentation. An explicitly
    // injected automation model still wins (the merge below prefers props.browserAutomation).
    const liveBrowserAutomation = useBrowserAutomationRuntime({
        enabled: policy.automationEnabled === true,
        engineBridge: liveBrowserDiagnostics?.bridge,
    });
    // The presence capsule names the session's agent and follows its turn; the host is the one that
    // knows which session this surface belongs to.
    // The agent's own browser (a daemon-owned view) is shown as its live stream: the daemon's
    // discovery names the capture source, the shared relay owner opens it.
    const hostActivelyViewed = useHostActivelyViewed();
    const streamedBrowserRuntime = useBrowserStreamedSurfaceRuntime({
        view: focusedView ?? null,
        browserSessionId: presenceSessionId,
        refreshKey: discoveryRefreshKey,
        enabled: policy.browserEnabled && policy.viewTargetsEnabled && props.visible !== false && hostActivelyViewed,
        machineId: props.pluginBrowserActionContext?.machineId,
        serverId: props.pluginBrowserActionContext?.serverId,
        onBrowserEvent: receiveBrowserEvent,
    });
    const baseBrowserAutomation = props.browserAutomation ?? liveBrowserAutomation;
    // The session whose agent drives this surface's browser: named by the presence capsule for every
    // view, whether or not in-app automation is enabled.
    const browserAgent = React.useMemo(() => (presenceSessionId
        ? { sessionId: presenceSessionId, serverId: presenceServerId }
        : null), [presenceServerId, presenceSessionId]);
    const mergedProductModels = mergeBrowserSurfaceProductModels(props.productModels, {
        browserContext: props.browserContext,
        browserDiagnostics: props.browserDiagnostics ?? renderableLiveBrowserDiagnostics,
        browserAutomation: baseBrowserAutomation,
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
    const borrowedAccountLifetime = useSessionViewerSourceAccountLifetime();
    const browserActionAccountLifetime = React.useMemo(() => props.pluginAccountLifetime
        ?? borrowedAccountLifetime ?? captureActiveServerAccountScopeLifetime(),
    [borrowedAccountLifetime, props.pluginAccountLifetime, resetKey]);
    const browserActionServerId = props.pluginBrowserActionContext?.serverId;
    // Approval can yield while the mounted policy/platform facts change. Read the current facts
    // at semantic dispatch, rather than letting the awaiting callback keep an old permission.
    const browserActionFactsRef = React.useRef({ unavailableReason, desktopWebViewAvailability,
        nativeViewCaptureHandlerRegistered, browserProfile, browserFeatureDecision,
        allowExternalUrlBrowsing: props.allowExternalUrlBrowsing ?? true });
    browserActionFactsRef.current = { unavailableReason, desktopWebViewAvailability,
        nativeViewCaptureHandlerRegistered, browserProfile, browserFeatureDecision,
        allowExternalUrlBrowsing: props.allowExternalUrlBrowsing ?? true };
    const isBrowserActionCurrent = React.useCallback(() => Boolean(mountedRef.current
        && Object.is(previousResetKeyRef.current, resetKey)
        && browserActionAccountLifetime?.isCurrent()
        && (!browserActionServerId || areServerProfileIdentifiersEquivalent(browserActionServerId, browserActionAccountLifetime.scope.serverId))),
    [browserActionAccountLifetime, browserActionServerId, resetKey]);
    const applyRuntimeDispatchResult = React.useCallback((result: BrowserControlCommandDispatchResult) => {
        if (!isBrowserActionCurrent()) return;
        const next = {
            browserState: result.state,
            navigationEffect: selectNavigationEffect(result.effects),
        };
        surfaceStateRef.current = next;
        setSurfaceState(next);
        for (const effect of result.effects) {
            if (effect.kind === 'clientLocalView' && (effect.command.kind === 'openView' || effect.command.kind === 'setTarget')) {
                props.onViewTargetChange?.({ browserSessionId: effect.command.browserSessionId,
                    viewId: effect.command.viewId, target: effect.command.target });
            }
        }
    }, [isBrowserActionCurrent, props.onViewTargetChange]);

    const daemonCommandSender = props.sendDaemonCommand ?? productModels?.browserContext?.daemonControl?.sendCommand;
    const sendDaemonCommand = React.useMemo(() => daemonCommandSender
        ? (command: BrowserCommandV1) => daemonCommandSender(command, (events) => {
            if (isBrowserActionCurrent()) applyDaemonEvents(events);
        })
        : undefined, [daemonCommandSender, applyDaemonEvents, isBrowserActionCurrent]);
    const runtimeControlAdapter = React.useMemo<BrowserRuntimeControlAdapter>(() => ({
        readState: () => isBrowserActionCurrent() && !browserActionFactsRef.current.unavailableReason ? surfaceStateRef.current.browserState : null,
        applyDispatchResult: applyRuntimeDispatchResult,
        readDispatchOptions: (command) => {
            const facts = browserActionFactsRef.current;
            return { desktopWebViewAvailability: facts.desktopWebViewAvailability,
                nativeViewCaptureHandlerRegistered: facts.nativeViewCaptureHandlerRegistered,
                ...((command.kind === 'openView' || command.kind === 'setTarget') ? {
                    targetPolicyDecision: evaluateBrowserTargetPolicy({ target: command.target, profile: facts.browserProfile,
                        browserFeatureDecision: facts.browserFeatureDecision, allowExternalUrlBrowsing: facts.allowExternalUrlBrowsing }),
                } : {}),
            };
        },
        ...(sendDaemonCommand ? { sendDaemonCommand } : {}),
    }), [isBrowserActionCurrent, applyRuntimeDispatchResult, sendDaemonCommand]);
    const executeBrowserAction = React.useMemo(() => createFrontDoorActionExecute(undefined, {
        runtimeActions: { browserControl: runtimeControlAdapter, browserAutomation: runtimeAutomationAdapter },
        isActionEnabled: () => isBrowserActionCurrent() && !browserActionFactsRef.current.unavailableReason,
    }), [runtimeControlAdapter, runtimeAutomationAdapter, isBrowserActionCurrent]);
    const subscribeBrowserEvents = props.subscribeBrowserEvents
        ?? (props.browserContext ?? props.productModels?.browserContext)?.daemonControl?.subscribeBrowserEvents;
    React.useEffect(() => subscribeBrowserEvents?.(event => applyDaemonEvents([event])), [subscribeBrowserEvents, applyDaemonEvents]);

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
        const unregister = [...new Set([props.browserSessionId, focusedView?.browserSessionId].filter((id): id is string => Boolean(id)))].map(browserSessionId =>
            registerBrowserRuntimeControlAdapter({ browserSessionId, control: runtimeControlAdapter,
                ...(runtimeAutomationAdapter ? { automation: runtimeAutomationAdapter } : {}) }));
        return () => unregister.forEach(dispose => dispose());
    }, [runtimeControlAdapter, props.browserSessionId, focusedView?.browserSessionId, runtimeAutomationAdapter, unavailableReason]);

    React.useEffect(() => {
        const machineId = props.pluginBrowserActionContext?.machineId?.trim();
        const sessionId = props.pluginBrowserActionContext?.sessionId?.trim();
        if (!machineId || !sessionId || !focusedView || !runtimeAutomationAdapter || unavailableReason
            || policy.automationEnabled !== true
            || (focusedView.engineKind !== 'webIframe' && focusedView.engineKind !== 'nativeWebView'
                && focusedView.engineKind !== 'desktopWebView')) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        const serverId = props.pluginBrowserActionContext?.serverId;
        // An explicitly Home-bound pane must never advertise its room on another Home's socket.
        if (serverId && (!lifetime || !areServerProfileIdentifiersEquivalent(serverId, lifetime.scope.serverId))) return;
        const view = { browserSessionId: focusedView.browserSessionId, viewId: focusedView.viewId, sessionId };
        let disposed = false;
        let unregister: (() => void) | undefined;
        const retirement = lifetime?.onRetire(() => {
            disposed = true;
            unregister?.();
        });
        // Keep the socket graph out of the synchronous surface render path.
        void import('@/sync/api/session/apiSocket').then(({ apiSocket }) => {
            if (disposed || lifetime?.isCurrent() === false) return;
            unregister = apiSocket.installBrowserAutomationReverseDispatch(machineId, view);
        });
        return () => {
            disposed = true;
            retirement?.dispose();
            unregister?.();
        };
    }, [focusedView?.browserSessionId, focusedView?.viewId, focusedView?.engineKind,
        policy.automationEnabled, props.pluginBrowserActionContext?.machineId,
        props.pluginBrowserActionContext?.serverId, props.pluginBrowserActionContext?.sessionId,
        runtimeAutomationAdapter, unavailableReason]);

    const onCommand = React.useCallback((command: BrowserCommandV1) => executeBrowserAction(browserControlActionId(command), command, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: browserActionAccountLifetime?.scope.serverId,
        expectedAccountId: browserActionAccountLifetime?.scope.accountId,
        defaultSessionId: props.pluginBrowserActionContext?.sessionId ?? undefined,
        defaultMachineId: props.pluginBrowserActionContext?.machineId ?? undefined,
    }), [executeBrowserAction, browserActionAccountLifetime, props.pluginBrowserActionContext?.sessionId, props.pluginBrowserActionContext?.machineId]);

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
        const viewId = resolveBrowserViewIdForTarget(target);
        void onCommand({
            kind: 'openView',
            commandId: `browser_command:${viewId}:open:${Date.now()}`,
            browserSessionId: props.browserSessionId,
            viewId,
            target,
            platform: options?.platform ?? props.platform,
            currentUrl: options?.currentUrl ?? resolveInitialCurrentUrl(target),
            currentUrlExpiresAt: options?.currentUrlExpiresAt,
            focus: true,
        });
    }, [
        onCommand,
        props.browserSessionId,
        props.platform,
    ]);

    const navigateActiveViewInPlace = React.useCallback((input: Readonly<{
        view: BrowserControlViewState;
        url: string;
        platform: BrowserPlatformV1;
    }>) => {
        // The source/view identity remains the same across daemon navigation. A local retarget
        // would replace the streamed projection and bypass the daemon navigation sink.
        if (isDaemonAuthoritativeBrowserView(input.view)) return false;
        const target = resolveExternalUrlTargetFromInput(input.url);
        if (
            !target
            || target.kind !== 'externalUrl'
            || !shouldRetargetActiveViewForAddressNavigation({ view: input.view, target })
        ) {
            return false;
        }
        void onCommand({
            kind: 'setTarget',
            commandId: `browser_command:${input.view.viewId}:setTarget:${Date.now()}`,
            browserSessionId: input.view.browserSessionId,
            viewId: input.view.viewId,
            target,
            currentUrl: target.url,
        });
        // The retarget attempt owns this submission even when refused: never fall through to
        // another navigation Action that could bypass the refused target decision.
        return true;
    }, [onCommand]);

    const onOpenTarget = React.useCallback((target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => {
        if (props.onOpenTarget) {
            props.onOpenTarget(target, options);
            return;
        }
        navigateCurrentTabInPlace(target, options);
    }, [navigateCurrentTabInPlace, props.onOpenTarget]);
    const resolveContributedAction = React.useMemo(
        () => createPluginUiProjectedActionResolver(props.pluginUiProjection?.actionsById),
        [props.pluginUiProjection?.actionsById],
    );
    const pluginBrowserActionAccountLifetime = props.pluginAccountLifetime ?? null;
    const pluginBrowserActionCurrentRef = React.useRef({
        accountLifetime: pluginBrowserActionAccountLifetime,
        interactionEnabled: props.pluginUiInteractionEnabled === true,
    });
    pluginBrowserActionCurrentRef.current = {
        accountLifetime: pluginBrowserActionAccountLifetime,
        interactionEnabled: props.pluginUiInteractionEnabled === true,
    };
    const onPluginBrowserAction = React.useCallback<NonNullable<React.ComponentProps<typeof BrowserShell>['onPluginBrowserAction']>>(
        (action, input) => {
            void executePluginBrowserAction({
                action,
                machineId: props.pluginBrowserActionContext?.machineId,
                serverId: props.pluginBrowserActionContext?.serverId,
                sessionId: props.pluginBrowserActionContext?.sessionId,
                input,
                policyContext: pluginBrowserPolicyContext,
                resolveContributedAction,
                pluginUiProjection: props.pluginUiProjection,
                accountLifetime: pluginBrowserActionAccountLifetime,
                ...(currentUiContextReader
                    ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
                    : {}),
                isCurrent: () => (
                    pluginBrowserActionCurrentRef.current.accountLifetime === pluginBrowserActionAccountLifetime
                    && pluginBrowserActionAccountLifetime?.isCurrent() === true
                    && pluginBrowserActionCurrentRef.current.interactionEnabled
                ),
            });
        },
        [
            props.pluginBrowserActionContext?.machineId,
            props.pluginBrowserActionContext?.serverId,
            props.pluginBrowserActionContext?.sessionId,
            props.pluginBrowserProjection?.generation,
            pluginBrowserPolicyContext,
            pluginBrowserActionAccountLifetime,
            resolveContributedAction,
            currentUiContextReader,
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
        <RetainedPresentationSlotBinder
            slotId={props.presentationSlotId ?? props.browserSessionId}
            visible={props.visible ?? true}
            enabled={props.keepAliveAboveRouter === true && typeof props.presentationSlotId === 'string'}
        >
            <BrowserShell
                agent={browserAgent}
                browserSessionId={focusedView?.browserSessionId ?? props.browserSessionId}
                viewId={focusedView?.viewId ?? null}
                platform={props.platform}
                state={surfaceState.browserState}
                onCommand={onCommand}
                daemonControlAvailable={sendDaemonCommand !== undefined}
                onViewLifecycle={applyViewLifecycleSignal}
                lifecycleState={lifecycleSlot ? lifecycleSnapshot.lifecycleState : undefined}
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
                onPluginBrowserAction={props.pluginUiInteractionEnabled === true ? onPluginBrowserAction : undefined}
                simulatorPreviewRuntime={props.simulatorPreviewRuntime}
                streamedBrowserRuntime={streamedBrowserRuntime}
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
                executionMachineId={props.pluginBrowserActionContext?.machineId}
                executionServerId={props.pluginBrowserActionContext?.serverId}
                executionSessionId={props.pluginBrowserActionContext?.sessionId}
                nowMs={props.nowMs}
                testID={props.testID}
            />
        </RetainedPresentationSlotBinder>
    );
}
