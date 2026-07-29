import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
    BrowserCommandV1,
    BrowserContextCapabilities,
    BrowserPlatformV1,
    BrowserRecordingCapabilities,
    BrowserRecordingPolicyStateV1,
    BrowserRecordingSessionV1,
    FeatureDecision,
    RuntimeActionExecute,
} from '@happier-dev/protocol';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol';

import { BrowserLaunchpad } from '@/components/browser/launchpad';
import type { BrowserLaunchpadOpenTargetOptions } from '@/components/browser/launchpad/BrowserLaunchpad';
import type {
    BrowserControlState,
    BrowserControlViewState,
    BrowserViewLifecycleSignal,
    BrowserViewLifecycleTarget,
} from '@/sync/domains/browser/control';
import {
    attachActiveBrowserPageReference,
    countBrowserAnnotationDraftMarks,
    createBrowserContextAnnotationAdapter,
    createDesktopBrowserAnnotationCaptureProvider,
    markBrowserContextViewNavigation,
    readBrowserAnnotationDraft,
    registerBrowserContextAnnotationAdapter,
    resolveBrowserAnnotationRuntimeActionIdForRequest,
    resolveBrowserAnnotationCaptureCapability,
    type BrowserAnnotationAdapterRequest,
    type BrowserAnnotationAdapterResult,
    type BrowserAnnotationCaptureCapability,
    type BrowserAnnotationCaptureProvider,
    type BrowserAnnotationDraftInput,
    type BrowserContextState,
    type BrowserContextUnavailableReason,
} from '@/sync/domains/browser/context';
import { AnnotationEditorOverlay, type AnnotationEditorMark } from '@/components/browser/annotation';
import {
    selectBrowserDiagnosticsForView,
    type BrowserDiagnosticsPanelProjection,
} from '@/sync/domains/browser/diagnostics';
import type { BrowserRecordingState } from '@/sync/domains/browser/recording';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    selectPluginBrowserActionsForPlacement,
    selectPluginBrowserToolbarActions,
    type PluginBrowserActionProjection,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/actions';
import {
    resolvePluginBrowserPolicyDecision,
} from '@/sync/domains/plugins/browser/policy';
import {
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import { resolvePluginUiIoniconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
    resolveExternalUrlTargetFromInput,
    selectActiveBrowserView,
    selectBrowserToolbarModel,
} from '@/sync/domains/browser/shell';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { openDesktopBrowserDevtools } from '@/sync/domains/browser/adapters/desktopWebViewBridge';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import type { BrowserControlCommandEffect } from '@/sync/domains/browser/control';

import { BrowserAddressField } from './BrowserAddressField';
import { BrowserLoadProgressBar } from './BrowserLoadProgressBar';
import {
    BrowserDiagnosticsDrawer,
    type BrowserDiagnosticsInteractionControls,
    type BrowserDiagnosticsRuntimeProjection,
} from './diagnostics';
import { BrowserOriginChip } from './BrowserOriginChip';
import {
    BrowserToolbarOverflowMenu,
    BrowserToolbarTitle,
    SecurityOriginIndicator,
    type BrowserToolbarOverflowItem,
} from './toolbar';
import { BrowserStatusBar } from './BrowserStatusBar';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserViewHost } from './BrowserViewHost';
import { BrowserPluginActionPlacements } from './BrowserPluginActionPlacements';
import { BrowserAutomationControls } from './automation';
import { type BrowserProfileStatusModel } from './profile/BrowserProfileStatus';
import { BrowserPrivacyPopover } from './profile/BrowserPrivacyPopover';
import { shouldSurfaceBrowserPrivacy } from './profile/browserPrivacyVisibility';
import type { BrowserDiagnosticsEngineBridgeConfig } from './frame/types';
import {
    BrowserRecordingControls,
    type BrowserRecordingControlsProps,
    type BrowserRecordingStartControlRequest,
} from './recording';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    toolbarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        // Wrap in narrow panes (the session-details browser surface is narrow): the address field
        // keeps a usable minimum width and the secondary controls (origin chip, context/annotation/
        // recording/automation) flow onto a second line instead of squeezing the flex address field
        // down to zero width — which previously hid the address bar entirely.
        flexWrap: 'wrap',
        rowGap: 8,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    addressFieldSlot: {
        // Priority slot: never collapses below a usable width, so wrapping pushes the secondary
        // controls to the next line rather than starving the address input.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 200,
        minWidth: 160,
    },
    viewHost: {
        flex: 1,
        minHeight: 0,
    },
}));

function createCommandId(kind: BrowserCommandV1['kind'], viewId: string): string {
    return `browser_command:${viewId}:${kind}:${Date.now()}`;
}

type RuntimeActionFailureResult = Readonly<{
    ok: false;
    errorCode?: string;
    error?: string;
}>;

function isRuntimeActionFailureResult(value: unknown): value is RuntimeActionFailureResult {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && 'ok' in value
        && (value as Readonly<{ ok?: unknown }>).ok === false,
    );
}

function buildAnnotationRuntimeActionInput(
    view: BrowserControlViewState,
    request: BrowserAnnotationAdapterRequest,
): unknown {
    const base = {
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
    };
    switch (request.kind) {
        case 'start':
        case 'cancel':
            return base;
        case 'captureRegion':
            return {
                ...base,
                ...(request.target ? { target: request.target } : {}),
                ...(request.comment ? { comment: request.comment } : {}),
                ...(request.styleIntent ? { styleIntent: request.styleIntent } : {}),
                ...(request.stroke ? { stroke: request.stroke } : {}),
            };
        case 'captureElement':
            return {
                ...base,
                target: request.target,
                ...(request.comment ? { comment: request.comment } : {}),
                ...(request.styleIntent ? { styleIntent: request.styleIntent } : {}),
                ...(request.stroke ? { stroke: request.stroke } : {}),
            };
        case 'attachComment':
            return {
                ...base,
                contextId: request.contextId,
                comment: request.comment,
            };
        case 'attachStroke':
            return {
                ...base,
                contextId: request.contextId,
                stroke: request.stroke,
            };
        case 'attachStyleIntent':
            return {
                ...base,
                contextId: request.contextId,
                styleIntent: request.styleIntent,
            };
        default:
            return base;
    }
}

export type BrowserShellContextState = Readonly<{
    state: BrowserContextState;
    contextCapabilities: BrowserContextCapabilities;
    enabled?: boolean;
    attachmentsUploadsEnabled?: boolean;
    browserDiagnosticsEnabled?: boolean;
    disabledReason?: string | null;
    annotationDraft?: BrowserAnnotationDraftInput | null;
    annotationCaptureProvider?: BrowserAnnotationCaptureProvider | null;
    /** True when `annotationCaptureProvider` is the daemon managed-Chromium CDP producer. */
    managedAnnotationCaptureProvider?: boolean;
    /**
     * Front-door dispatcher for the `browser.context.annotation.*` actions. When the host supplies
     * it (wired to `ActionExecutor.execute`), the toolbar handlers dispatch through it so the
     * user-initiated path shares the exact runtime-action front door an agent uses (enablement +
     * approval gates applied uniformly). When omitted, BrowserShell dispatches through a local
     * adapter built from the live binding (standalone/test path) — same canonical reducer owner.
     */
    annotationRuntimeActionExecute?: RuntimeActionExecute;
    /**
     * Legacy/test seam for callers that already own annotation dispatch. Product session hosts
     * should supply `annotationRuntimeActionExecute`; this seam remains a narrow fallback for
     * standalone BrowserShell tests and non-session embeddings.
     */
    dispatchAnnotationAction?: (
        request: BrowserAnnotationAdapterRequest,
    ) => Promise<BrowserAnnotationAdapterResult> | BrowserAnnotationAdapterResult;
    nowMs?: () => number;
    onStateChange: (state: BrowserContextState) => void;
    onAttachPageReferenceChange?: (handler: (() => void) | null) => void;
    onAttachUnavailable?: (reason: BrowserContextUnavailableReason) => void;
    /**
     * ANNO-1 Select tool: the app-layer overlay intercepts pointer events so it cannot hit-test the
     * page DOM directly. The host wires this to the element-picker owner, which resolves a picked
     * element and dispatches `addDraftTarget` through the same annotation adapter. Absent ⇒ Select is
     * an inert affordance (no fabricated element target).
     */
    onAnnotationSelectElement?: () => void;
}>;

type BrowserShellDiagnosticsState = BrowserDiagnosticsRuntimeProjection & Readonly<{
    interaction?: BrowserDiagnosticsInteractionControls;
}>;

export type BrowserShellRecordingState = Readonly<{
    state: BrowserRecordingState;
    recordingCapabilities: BrowserRecordingCapabilities;
    enabled?: boolean;
    policyState?: BrowserRecordingPolicyStateV1;
    nowMs?: () => number;
    onStartRecording?: (request: BrowserRecordingStartControlRequest) => void;
    onStopRecording?: (recording: BrowserRecordingSessionV1) => void;
    onCancelRecording?: (recording: BrowserRecordingSessionV1) => void;
    onUnavailable?: (reason: Readonly<{ reasonCode: string; message: string }>) => void;
    isCaptureSourceAvailable?: BrowserRecordingControlsProps['isCaptureSourceAvailable'];
}>;

export type BrowserShellAutomationState = Readonly<{
    controlService: BrowserAutomationControlService;
    enabled?: boolean;
    supportedActions?: readonly string[];
    nowMs?: () => number;
    onRegistrationRejected?: (reasonCode: string) => void;
    onRejectedMessage?: (reasonCode: string) => void;
}>;

export type BrowserShellProfileState = BrowserProfileStatusModel;

function resolveActiveDiagnosticsBridge(input: Readonly<{
    activeView: ReturnType<typeof selectActiveBrowserView>;
    diagnostics?: BrowserShellDiagnosticsState | null;
}>): BrowserDiagnosticsEngineBridgeConfig | undefined {
    const activeView = input.activeView;
    const bridge = input.diagnostics?.bridge;
    if (!activeView || !bridge) {
        return undefined;
    }
    if (
        bridge.browserSessionId !== activeView.browserSessionId
        || bridge.viewId !== activeView.viewId
        || bridge.navigationGeneration !== activeView.navigationGeneration
    ) {
        return undefined;
    }
    return bridge;
}

export function BrowserShell(props: Readonly<{
    browserSessionId: string;
    /**
     * The active view to render, supplied by the workspace-selected `browser-view` tab's
     * `resource.viewId`. When omitted, the sole view for the session is used. The browser is a
     * single-active-view renderer; tab order/active/open/close live on the details-workspace
     * engine (one tab system), so there is no inner tab strip here.
     */
    viewId?: string | null;
    platform: BrowserPlatformV1;
    state: BrowserControlState;
    onCommand: (command: BrowserCommandV1) => void;
    /**
     * B-2 cause-2: a sink the in-app render engines call to feed their page-load lifecycle
     * (iframe `onLoad`/`onError`, RN `onLoadStart`/`onLoadEnd`/`onError`, desktop `publishPageInfo`)
     * back to the control reducer so a URL-bearing open transitions `loading → ready/failed`. The
     * state owner (`BrowserSurfaceHost`) supplies it; when absent, engines simply report nothing.
     */
    onViewLifecycle?: (target: BrowserViewLifecycleTarget, signal: BrowserViewLifecycleSignal) => void;
    launchpadRows?: readonly BrowserLaunchpadRow[];
    launchpadRefreshStatus?: 'idle' | 'refreshing' | 'error';
    launchpadRefreshError?: string | null;
    onOpenTarget?: (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void;
    /**
     * OWNER-NAV (DV-NAV): navigate the CURRENT tab in place (the launchpad/new-tab URL entry uses
     * this). Distinct from `onOpenTarget`, which opens a NEW workspace tab and is reserved for
     * external surfaces (Services rows, session-header button).
     */
    onNavigateInPlace?: (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void;
    /**
     * Lets the surface owner decide whether a typed address in an active view should replace the
     * view target (for example local-preview -> external URL) instead of issuing an in-target
     * navigation command. BrowserShell owns input capture; BrowserSurfaceHost owns target policy
     * and control-state mutation.
     */
    onNavigateActiveViewInPlace?: (input: Readonly<{
        view: BrowserControlViewState;
        url: string;
        platform: BrowserPlatformV1;
    }>) => boolean;
    browserFeatureDecision?: FeatureDecision | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiInteractionEnabled?: boolean;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginBrowserPolicyContext?: PluginUiPolicyEvaluationContext;
    onPluginBrowserAction?: (
        action: PluginBrowserActionProjection,
        input: Readonly<{
            browserSessionId: string;
            viewId: string;
            targetId: string;
            currentUrl?: string;
        }>,
    ) => void;
    simulatorPreviewRuntime?: SimulatorPreviewSurfaceRuntime | null;
    browserContext?: BrowserShellContextState | null;
    browserDiagnostics?: BrowserShellDiagnosticsState | null;
    browserAutomation?: BrowserShellAutomationState | null;
    browserRecording?: BrowserShellRecordingState | null;
    browserProfile?: BrowserShellProfileState | null;
    navigationEffect?: BrowserControlCommandEffect | null;
    supplementalDiagnostics?: BrowserDiagnosticsPanelProjection | null;
    searchUrlTemplate?: string;
    nowMs?: () => number;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-shell';
    const activeView = selectActiveBrowserView(props.state, props.browserSessionId, props.viewId);
    const browserDiagnostics = props.browserDiagnostics === undefined
        ? null
        : props.browserDiagnostics;
    const activeViewNavigationKey = activeView
        ? `${activeView.viewId}:${activeView.navigationGeneration}`
        : '';
    const toolbar = selectBrowserToolbarModel(activeView);
    const activeSession = props.state.sessionsById[props.browserSessionId] ?? null;
    const launchpadRows = props.launchpadRows ?? [];
    const pluginBrowserPolicyContext = React.useMemo(
        () => createPluginUiPolicyEvaluationContext(
            {
                platform: props.platform,
                profileMode: props.browserProfile?.profile?.storageMode === 'plugin'
                    ? undefined
                    : props.browserProfile?.profile?.storageMode,
            },
            props.pluginBrowserPolicyContext,
        ),
        [props.browserProfile?.profile?.storageMode, props.platform, props.pluginBrowserPolicyContext],
    );
    const pluginBrowserToolbarActions = React.useMemo(
        () => selectPluginBrowserToolbarActions({
            projection: props.pluginBrowserProjection,
            targetId: activeView?.target.targetId,
            policyContext: pluginBrowserPolicyContext,
        }),
        [activeView?.target.targetId, pluginBrowserPolicyContext, props.pluginBrowserProjection],
    );
    const pluginBrowserDetailsPanelActions = React.useMemo(
        () => selectPluginBrowserActionsForPlacement({
            projection: props.pluginBrowserProjection,
            targetId: activeView?.target.targetId,
            placement: 'detailsPanel',
            policyContext: pluginBrowserPolicyContext,
        }),
        [activeView?.target.targetId, pluginBrowserPolicyContext, props.pluginBrowserProjection],
    );
    const pluginBrowserContextMenuActions = React.useMemo(
        () => selectPluginBrowserActionsForPlacement({
            projection: props.pluginBrowserProjection,
            targetId: activeView?.target.targetId,
            placement: 'contextMenu',
            policyContext: pluginBrowserPolicyContext,
        }),
        [activeView?.target.targetId, pluginBrowserPolicyContext, props.pluginBrowserProjection],
    );
    const showLaunchpad = !activeView;
    const activeLocalPreviewMachineId = activeView?.target.kind === 'localServicePreview'
        ? activeView.target.machineId
        : null;
    const liveLocalServicePreviewState = useLocalServicePreviewState({
        machineId: activeLocalPreviewMachineId,
        serverId: props.localServicePreviewServerId,
        enabled: props.localServicePreviewState === undefined,
    });
    const localServicePreviewState =
        props.localServicePreviewState !== undefined
            ? props.localServicePreviewState
            : liveLocalServicePreviewState;
    const activeDiagnostics = activeView && browserDiagnostics
        ? selectBrowserDiagnosticsForView(browserDiagnostics.state, {
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
        })
        : null;
    const diagnosticsBridge = resolveActiveDiagnosticsBridge({
        activeView,
        diagnostics: browserDiagnostics,
    });
    const browserContextRef = React.useRef(props.browserContext);
    browserContextRef.current = props.browserContext;

    const dispatchViewCommand = React.useCallback((kind: 'goBack' | 'goForward' | 'reload' | 'stop') => {
        if (!activeView) return;
        props.onCommand({
            kind,
            commandId: createCommandId(kind, activeView.viewId),
            browserSessionId: props.browserSessionId,
            viewId: activeView.viewId,
        });
    }, [activeView, props]);

    const dispatchNavigate = React.useCallback((url: string) => {
        if (!activeView) {
            // B-1: with no active view the toolbar address bar is the NEW-TAB entry point — a typed
            // address opens the first view IN PLACE through the SAME `onNavigateInPlace` seam the
            // in-content launchpad URL entry uses (never a sibling workspace tab). The address field
            // already normalized the input to an http(s) URL; route it through the one
            // address→target builder so the two URL-entry surfaces never drift.
            const onNavigateInPlace = props.onNavigateInPlace;
            if (!onNavigateInPlace) return;
            const target = resolveExternalUrlTargetFromInput(url);
            if (!target) return;
            onNavigateInPlace(target, { platform: props.platform });
            return;
        }
        if (props.onNavigateActiveViewInPlace?.({
            view: activeView,
            url,
            platform: props.platform,
        }) === true) {
            return;
        }
        props.onCommand({
            kind: 'navigate',
            commandId: createCommandId('navigate', activeView.viewId),
            browserSessionId: props.browserSessionId,
            viewId: activeView.viewId,
            url,
        });
    }, [activeView, props]);

    const desktopNativeDevtoolsAvailable = Boolean(
        activeView
        && props.desktopWebViewAvailability?.available
        && props.desktopWebViewAvailability.supports.nativeDevtools,
    );
    const openDesktopDevtools = React.useCallback(() => {
        if (!activeView) return;
        void openDesktopBrowserDevtools({
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
        });
    }, [activeView]);

    const attachBrowserContext = React.useCallback(() => {
        const browserContext = browserContextRef.current;
        if (!browserContext) return;

        const result = attachActiveBrowserPageReference({
            state: browserContext.state,
            browserContextEnabled: browserContext.enabled !== false,
            contextCapabilities: browserContext.contextCapabilities,
            view: activeView,
            capturedAtMs: browserContext.nowMs?.() ?? Date.now(),
        });

        if (result.status === 'attached') {
            browserContext.onStateChange(result.state);
            return;
        }

        browserContext.onAttachUnavailable?.(result.reason);
    }, [activeView]);

    // The in-app annotation capture provider. Prefer an explicitly-supplied provider; otherwise use
    // the desktop (Wry) native-snapshot producer when the active desktop engine advertises capture
    // support. iframe/RN engines have no first-party screenshot producer yet (12.20B) → no provider
    // → the capture button stays disabled (honest fail-closed).
    const desktopCaptureSupported = Boolean(
        activeView
        && activeView.engineKind === 'desktopWebView'
        && props.desktopWebViewAvailability?.available
        && props.desktopWebViewAvailability.supports.capture,
    );
    const desktopCaptureProvider = React.useMemo<BrowserAnnotationCaptureProvider | null>(() => {
        if (!desktopCaptureSupported) return null;
        return createDesktopBrowserAnnotationCaptureProvider({ available: true });
    }, [desktopCaptureSupported]);
    const suppliedCaptureProvider = props.browserContext?.annotationCaptureProvider ?? null;
    const effectiveCaptureProvider = props.browserContext?.managedAnnotationCaptureProvider === true
        ? (activeView?.adapterKind === 'chromiumSidecar' ? suppliedCaptureProvider : desktopCaptureProvider)
        : suppliedCaptureProvider ?? desktopCaptureProvider;

    const invokePluginBrowserAction = React.useCallback((action: PluginBrowserActionProjection) => {
        if (!activeView || !props.onPluginBrowserAction) {
            return;
        }
        const currentUrl = activeView.pendingUrl ?? activeView.currentUrl ?? undefined;
        props.onPluginBrowserAction(action, {
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
            targetId: activeView.target.targetId,
            ...(currentUrl ? { currentUrl } : {}),
        });
    }, [activeView, props.onPluginBrowserAction]);

    // Single canonical annotation owner. The local adapter reads the live binding (state + view +
    // capabilities + capture provider) on each dispatch and commits via `onStateChange`; it is the
    // SAME adapter shape registered for the front door so an agent and the toolbar share one path.
    const activeViewRef = React.useRef(activeView);
    activeViewRef.current = activeView;
    const effectiveCaptureProviderRef = React.useRef(effectiveCaptureProvider);
    effectiveCaptureProviderRef.current = effectiveCaptureProvider;

    const annotationAdapter = React.useMemo(() => createBrowserContextAnnotationAdapter({
        resolveBinding: () => {
            const browserContext = browserContextRef.current;
            return {
                state: browserContext?.state ?? ({} as BrowserContextState),
                view: activeViewRef.current,
                browserContextEnabled: browserContext?.enabled !== false,
                browserDiagnosticsEnabled: browserContext?.browserDiagnosticsEnabled,
                attachmentsUploadsEnabled: browserContext?.attachmentsUploadsEnabled,
                contextCapabilities: browserContext?.contextCapabilities ?? ({} as BrowserContextCapabilities),
                captureProvider: effectiveCaptureProviderRef.current,
                annotationDraft: browserContext?.annotationDraft,
                nowMs: browserContext?.nowMs,
            };
        },
        onStateChange: (state) => {
            browserContextRef.current?.onStateChange(state);
        },
    }), []);

    // Register the adapter so the runtime-action front door (and thus an agent) can drive annotation
    // for the active session/view. Keyed on the live view so a stale host can't service another view.
    React.useEffect(() => {
        const browserContext = props.browserContext;
        if (!browserContext || !activeView) return undefined;
        return registerBrowserContextAnnotationAdapter({
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
            adapter: annotationAdapter,
        });
    }, [annotationAdapter, activeView, props.browserContext]);

    const dispatchAnnotation = React.useCallback(async (
        request: BrowserAnnotationAdapterRequest,
    ): Promise<void> => {
        const browserContext = browserContextRef.current;
        if (!browserContext) return;
        const actionId = resolveBrowserAnnotationRuntimeActionIdForRequest(request);
        if (actionId && browserContext.annotationRuntimeActionExecute && activeViewRef.current) {
            const result = await browserContext.annotationRuntimeActionExecute({
                actionId,
                input: buildAnnotationRuntimeActionInput(activeViewRef.current, request),
                context: {
                    surface: 'ui',
                    placement: 'browser_context',
                },
            });
            if (isRuntimeActionFailureResult(result)) {
                browserContext.onAttachUnavailable?.({
                    reasonCode: 'browser_context_annotation_capture_unavailable',
                    lifecycleState: 'adapterUnavailable',
                    message: result.error ?? result.errorCode ?? 'browser_context_annotation_unavailable',
                });
            }
            return;
        }
        const dispatcher = browserContext.dispatchAnnotationAction
            ?? annotationAdapter.dispatch;
        const result = await dispatcher(request);
        if (result.status === 'unavailable') {
            const reason = typeof result.reason === 'string'
                ? { reasonCode: 'browser_context_annotation_capture_unavailable' as const, lifecycleState: 'adapterUnavailable' as const, message: result.reason }
                : result.reason;
            browserContext.onAttachUnavailable?.(reason);
        }
    }, [annotationAdapter]);

    const startAnnotation = React.useCallback(() => {
        void dispatchAnnotation({ kind: 'start' });
    }, [dispatchAnnotation]);

    const cancelAnnotation = React.useCallback(() => {
        void dispatchAnnotation({ kind: 'cancel' });
    }, [dispatchAnnotation]);

    const captureAnnotation = React.useCallback(async () => {
        const browserContext = browserContextRef.current;
        if (!browserContext) return;
        // The toolbar capture button captures a full-page region annotation. When a caller-supplied
        // draft target exists it is honored; otherwise the capture provider produces the region.
        const draftTarget = browserContext.annotationDraft?.target;
        if (draftTarget?.kind === 'element') {
            await dispatchAnnotation({
                kind: 'captureElement',
                target: draftTarget,
                ...(browserContext.annotationDraft?.comment ? { comment: browserContext.annotationDraft.comment } : {}),
                ...(browserContext.annotationDraft?.styleIntent ? { styleIntent: browserContext.annotationDraft.styleIntent } : {}),
                ...(browserContext.annotationDraft?.stroke ? { stroke: browserContext.annotationDraft.stroke } : {}),
            });
            return;
        }
        await dispatchAnnotation({
            kind: 'captureRegion',
            // Omit target → the capture provider produces the full-page region snapshot. A marquee
            // region draft (if present) overrides it.
            ...(draftTarget?.kind === 'region' ? { target: draftTarget } : {}),
            ...(browserContext.annotationDraft?.comment ? { comment: browserContext.annotationDraft.comment } : {}),
            ...(browserContext.annotationDraft?.styleIntent ? { styleIntent: browserContext.annotationDraft.styleIntent } : {}),
            ...(browserContext.annotationDraft?.stroke ? { stroke: browserContext.annotationDraft.stroke } : {}),
        });
    }, [dispatchAnnotation]);

    const onAttachPageReferenceChange = props.browserContext?.onAttachPageReferenceChange;
    React.useEffect(() => {
        if (!onAttachPageReferenceChange) return undefined;
        onAttachPageReferenceChange(activeView ? attachBrowserContext : null);
        return () => {
            onAttachPageReferenceChange(null);
        };
    }, [activeView, attachBrowserContext, onAttachPageReferenceChange]);

    React.useEffect(() => {
        const browserContext = props.browserContext;
        if (!browserContext || !activeView) return;

        const nextState = markBrowserContextViewNavigation(browserContext.state, {
            viewId: activeView.viewId,
            navigationGeneration: activeView.navigationGeneration,
        });
        if (nextState === browserContext.state) return;

        browserContext.onStateChange(nextState);
    }, [props.browserContext, activeViewNavigationKey]);

    const browserContextButtonDisabled = !activeView || Boolean(props.browserContext?.disabledReason);
    const activeAnnotation = activeView
        ? props.browserContext?.state.activeAnnotationByViewId?.[activeView.viewId]
        : null;
    const annotationSupported = props.browserContext?.contextCapabilities.supportedContextKinds.includes('browserAnnotation') === true;
    const annotationDraftAvailable = Boolean(props.browserContext?.annotationDraft)
        || effectiveCaptureProvider?.available === true;

    // ANNO-1 in-page editor view model. The overlay is the visual authoring surface; it dispatches
    // the same DRAFT actions the adapter owns (no parallel reducer). It mounts only while annotation
    // mode is active for the live view. Capture availability comes from the ANNO-6 engine-matrix
    // capability owner so the overlay surfaces a disabled-with-reason state on engines with no
    // cropped-capture producer (iframe / RN), never silently hiding.
    const annotationEditorActive = annotationSupported && Boolean(activeAnnotation) && Boolean(activeView);
    const annotationCaptureCapability = React.useMemo<BrowserAnnotationCaptureCapability>(() => {
        if (!activeView) {
            return { available: false, disabledReason: 'browser_context_annotation_capture_unavailable' };
        }
        return resolveBrowserAnnotationCaptureCapability({
            adapterKind: activeView.adapterKind,
            primaryEngine: activeView.engineKind,
            desktopCaptureSupported,
            managedCaptureGateEnabled: props.browserContext?.managedAnnotationCaptureProvider === true
            && effectiveCaptureProvider?.available === true,
        });
    }, [activeView, desktopCaptureSupported, effectiveCaptureProvider?.available, props.browserContext?.managedAnnotationCaptureProvider]);
    const annotationCaptureProducerUnavailable = annotationCaptureCapability.available === false
        && effectiveCaptureProvider?.available !== true;
    const browserContextDisabledReason = React.useMemo(() => {
        const disabledReason = props.browserContext?.disabledReason;
        if (typeof disabledReason === 'string' && disabledReason.length > 0) {
            return resolveReasonCopy({ reasonCode: disabledReason, kind: 'browserFrame' }).message;
        }
        return !activeView
            ? resolveReasonCopy({ reasonCode: 'target_kind_unavailable', kind: 'browserFrame' }).message
            : null;
    }, [activeView, props.browserContext?.disabledReason]);
    const annotationCaptureDisabledReason = annotationCaptureCapability.available === false
        ? resolveReasonCopy({ reasonCode: annotationCaptureCapability.disabledReason, kind: 'browserFrame' }).message
        : null;
    const annotationSelectCapability = props.browserContext?.onAnnotationSelectElement
        ? { available: true as const }
        : {
            available: false as const,
            disabledReason: 'browser_context_annotation_picker_unavailable',
        };
    const annotationDraft = activeView && props.browserContext
        ? readBrowserAnnotationDraft(props.browserContext.state, activeView.viewId)
        : null;
    const annotationMarkCount = activeView && props.browserContext
        ? countBrowserAnnotationDraftMarks(props.browserContext.state, activeView.viewId)
        : 0;
    const annotationMarks = React.useMemo<readonly AnnotationEditorMark[]>(() => {
        if (!annotationDraft) return [];
        return [
            ...annotationDraft.targets.map((target) => ({
                draftId: target.draftId,
                kind: 'element' as const,
                label: t('browserContext.editor.markElement', { label: target.accessibleName ?? target.selectorPath }),
                rect: target.rect,
            })),
            ...annotationDraft.regions.map((region) => ({
                draftId: region.draftId,
                kind: 'region' as const,
                label: t('browserContext.editor.markRegion'),
                rect: region.rect,
            })),
            ...annotationDraft.strokes.map((stroke) => ({
                draftId: stroke.draftId,
                kind: 'stroke' as const,
                label: t('browserContext.editor.markStroke'),
                points: stroke.points,
            })),
        ];
    }, [annotationDraft]);
    const annotationCommentValue = annotationDraft?.comment ?? '';

    const handleAnnotationAddRegion = React.useCallback((rect: Readonly<{ x: number; y: number; width: number; height: number }>) => {
        void dispatchAnnotation({ kind: 'addDraftRegion', rect });
    }, [dispatchAnnotation]);
    const handleAnnotationAddStroke = React.useCallback((points: readonly Readonly<{ x: number; y: number }>[]) => {
        void dispatchAnnotation({ kind: 'addDraftStroke', stroke: { shape: 'freehand', points } });
    }, [dispatchAnnotation]);
    const handleAnnotationRemoveMark = React.useCallback((draftId: string) => {
        void dispatchAnnotation({ kind: 'removeDraftTarget', draftId });
    }, [dispatchAnnotation]);
    const handleAnnotationCommentChange = React.useCallback((comment: string) => {
        void dispatchAnnotation({ kind: 'setDraftComment', comment });
    }, [dispatchAnnotation]);
    const handleAnnotationAttach = React.useCallback(() => {
        void dispatchAnnotation({ kind: 'attachDraft' });
    }, [dispatchAnnotation]);
    const handleAnnotationSelectElement = React.useCallback(() => {
        browserContextRef.current?.onAnnotationSelectElement?.();
    }, []);

    // Secondary single-shot tools live in an overflow Popover so the toolbar stops wrapping onto a
    // second line in narrow panes. Live-status controls (privacy / recording / automation pills)
    // stay inline because they convey ongoing state, not a one-tap action.
    const overflowItems = React.useMemo<readonly BrowserToolbarOverflowItem[]>(() => {
        const items: BrowserToolbarOverflowItem[] = [];
        if (desktopNativeDevtoolsAvailable) {
            items.push({
                id: 'open-devtools',
                iconName: 'bug-outline',
                label: t('browserShell.toolbar.openNativeDevtools'),
                onPress: openDesktopDevtools,
            });
        }
        if (props.browserContext) {
            items.push({
                id: 'attach-context',
                iconName: 'globe-outline',
                label: t('browserContext.composer.attachPageReference'),
                onPress: attachBrowserContext,
                disabled: browserContextButtonDisabled,
                disabledReason: browserContextButtonDisabled ? browserContextDisabledReason : null,
            });
            if (annotationSupported) {
                if (activeAnnotation) {
                    items.push({
                        id: 'capture-annotation',
                        iconName: 'checkmark-outline',
                        label: t('browserContext.composer.attachAnnotation'),
                        onPress: () => { void captureAnnotation(); },
                        disabled: browserContextButtonDisabled || !annotationDraftAvailable,
                        disabledReason: browserContextButtonDisabled
                            ? browserContextDisabledReason
                            : !annotationDraftAvailable
                                ? annotationCaptureDisabledReason
                                : null,
                        tone: 'active',
                    });
                    items.push({
                        id: 'cancel-annotation',
                        iconName: 'close-outline',
                        label: t('browserContext.composer.cancelAnnotation'),
                        onPress: cancelAnnotation,
                        disabled: browserContextButtonDisabled,
                        disabledReason: browserContextButtonDisabled ? browserContextDisabledReason : null,
                    });
                } else {
                    items.push({
                        id: 'start-annotation',
                        iconName: 'create-outline',
                        label: t('browserContext.composer.startAnnotation'),
                        onPress: startAnnotation,
                        disabled: browserContextButtonDisabled || annotationCaptureProducerUnavailable,
                        disabledReason: browserContextButtonDisabled
                            ? browserContextDisabledReason
                            : annotationCaptureProducerUnavailable
                                ? annotationCaptureDisabledReason
                                : null,
                    });
                }
            }
        }
        if (activeView && props.onPluginBrowserAction) {
            for (const action of pluginBrowserToolbarActions) {
                const policyDecision = resolvePluginBrowserPolicyDecision(
                    action,
                    pluginBrowserPolicyContext,
                );
                items.push({
                    id: action.id,
                    iconName: resolvePluginUiIoniconName(action.display.iconToken),
                    label: action.display.title,
                    onPress: () => invokePluginBrowserAction(action),
                    disabled: !policyDecision.enabled,
                    disabledReason: policyDecision.unavailableReason,
                });
            }
        }
        return items;
    }, [
        desktopNativeDevtoolsAvailable,
        openDesktopDevtools,
        props.browserContext,
        attachBrowserContext,
        browserContextButtonDisabled,
        browserContextDisabledReason,
        annotationSupported,
        activeAnnotation,
        annotationCaptureProducerUnavailable,
        annotationCaptureDisabledReason,
        captureAnnotation,
        annotationDraftAvailable,
        cancelAnnotation,
        startAnnotation,
        activeView,
        pluginBrowserToolbarActions,
        pluginBrowserPolicyContext,
        invokePluginBrowserAction,
        props.onPluginBrowserAction,
    ]);

    return (
        <View testID={testID} style={stylesheet.root}>
            <View style={stylesheet.toolbarRow}>
                <BrowserToolbar
                    testID={testID}
                    model={toolbar}
                    onBack={() => dispatchViewCommand('goBack')}
                    onForward={() => dispatchViewCommand('goForward')}
                    onReload={() => dispatchViewCommand('reload')}
                    onStop={() => dispatchViewCommand('stop')}
                />
                <View style={stylesheet.addressFieldSlot}>
                    <BrowserAddressField
                        testID={`${testID}-address`}
                        value={activeView?.pendingUrl ?? activeView?.currentUrl ?? ''}
                        disabled={activeView ? !toolbar.canNavigate : !props.onNavigateInPlace}
                        searchUrlTemplate={props.searchUrlTemplate}
                        onNavigate={dispatchNavigate}
                    />
                </View>
                <SecurityOriginIndicator
                    testID={`${testID}-security`}
                    view={activeView}
                />
                <BrowserToolbarTitle
                    testID={`${testID}-title`}
                    view={activeView}
                />
                <BrowserOriginChip
                    testID={`${testID}-origin`}
                    view={activeView}
                />
                {props.browserProfile && shouldSurfaceBrowserPrivacy(props.browserProfile) ? (
                    <BrowserPrivacyPopover
                        testID={`${testID}-privacy`}
                        model={props.browserProfile}
                    />
                ) : null}
                <BrowserToolbarOverflowMenu
                    testID={`${testID}-overflow`}
                    items={overflowItems}
                />
                {props.browserRecording ? (
                    <BrowserRecordingControls
                        testID={`${testID}-recording`}
                        view={activeView}
                        profileId={activeSession?.profileId ?? null}
                        state={props.browserRecording.state}
                        recordingCapabilities={props.browserRecording.recordingCapabilities}
                        enabled={props.browserRecording.enabled}
                        policyState={props.browserRecording.policyState}
                        nowMs={props.browserRecording.nowMs ?? props.nowMs}
                        onStartRecording={props.browserRecording.onStartRecording}
                        onStopRecording={props.browserRecording.onStopRecording}
                        onCancelRecording={props.browserRecording.onCancelRecording}
                        onUnavailable={props.browserRecording.onUnavailable}
                        isCaptureSourceAvailable={props.browserRecording.isCaptureSourceAvailable}
                    />
                ) : null}
                {props.browserAutomation ? (
                    <BrowserAutomationControls
                        testID={`${testID}-automation`}
                        view={activeView}
                        controlService={props.browserAutomation.controlService}
                        enabled={props.browserAutomation.enabled}
                    />
                ) : null}
            </View>
            <View style={stylesheet.viewHost}>
                <BrowserLoadProgressBar
                    testID={`${testID}-load-progress`}
                    progress={activeView?.loadingProgress ?? null}
                    loading={activeView?.loadingState === 'loading'}
                />
                {showLaunchpad ? (
                    <BrowserLaunchpad
                        testID={`${testID}-launchpad`}
                        rows={launchpadRows}
                        platform={props.platform}
                        browserProfile={props.browserProfile?.profile ?? null}
                        browserFeatureDecision={props.browserFeatureDecision}
                        desktopWebViewAvailability={props.desktopWebViewAvailability}
                        allowExternalUrlBrowsing={props.allowExternalUrlBrowsing}
                        refreshStatus={props.launchpadRefreshStatus ?? 'idle'}
                        refreshError={props.launchpadRefreshError}
                        onOpenTarget={props.onOpenTarget}
                        onNavigateInPlace={props.onNavigateInPlace}
                    />
                ) : (
                    <BrowserViewHost
                        testID={`${testID}-view`}
                        view={activeView}
                        onViewLifecycle={props.onViewLifecycle}
                        localServicePreviewState={localServicePreviewState}
                        pluginUiProjection={props.pluginUiProjection}
                        projectionInteractionEnabled={props.pluginUiInteractionEnabled}
                        simulatorPreviewRuntime={props.simulatorPreviewRuntime}
                        navigationEffect={props.navigationEffect}
                        diagnosticsBridge={diagnosticsBridge}
                        browserAutomation={props.browserAutomation}
                        browserProfile={props.browserProfile?.profile ?? null}
                        nowMs={props.nowMs}
                    />
                )}
                {annotationEditorActive ? (
                    <AnnotationEditorOverlay
                        testID={`${testID}-annotation-editor`}
                        captureCapability={annotationCaptureCapability}
                        selectCapability={annotationSelectCapability}
                        markCount={annotationMarkCount}
                        marks={annotationMarks}
                        comment={annotationCommentValue}
                        onSelectElement={handleAnnotationSelectElement}
                        onAddRegion={handleAnnotationAddRegion}
                        onAddStroke={handleAnnotationAddStroke}
                        onRemoveMark={handleAnnotationRemoveMark}
                        onCommentChange={handleAnnotationCommentChange}
                        onAttach={handleAnnotationAttach}
                        onCancel={cancelAnnotation}
                    />
                ) : null}
            </View>
            {activeView && props.onPluginBrowserAction ? (
                <BrowserPluginActionPlacements
                    detailsPanelActions={pluginBrowserDetailsPanelActions}
                    contextMenuActions={pluginBrowserContextMenuActions}
                    policyContext={pluginBrowserPolicyContext}
                    onAction={invokePluginBrowserAction}
                    testID={`${testID}-plugin-action`}
                />
            ) : null}
            {activeDiagnostics ? (
                <BrowserDiagnosticsDrawer
                    diagnostics={activeDiagnostics}
                    interaction={browserDiagnostics?.interaction}
                    testID={`${testID}-diagnostics`}
                />
            ) : null}
            {props.supplementalDiagnostics ? (
                <BrowserDiagnosticsDrawer
                    diagnostics={props.supplementalDiagnostics}
                    testID={`${testID}-supplemental-diagnostics`}
                />
            ) : null}
            <BrowserStatusBar
                testID={`${testID}-status`}
                view={activeView}
            />
        </View>
    );
}
