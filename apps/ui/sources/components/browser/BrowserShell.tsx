import * as React from 'react';
import { Platform, View } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
    BrowserCommandV1} from '@happier-dev/protocol/browser/control/v1';
import type {
    BrowserPlatformV1} from '@happier-dev/protocol/browser/view/v1';
import type {
    BrowserRecordingCapabilities} from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type {
    BrowserRecordingPolicyStateV1,
    BrowserRecordingSessionV1} from '@happier-dev/protocol/browser/recording/v1';
import type {
    FeatureDecision} from '@happier-dev/protocol/features/decision';
import type {
    ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { isProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';

import { BrowserLaunchpad } from '@/components/browser/launchpad';
import { useClaimedStackHeaderActions, useLentHeaderMenuRows } from '@/components/navigation/stackHeaderActions';
import { resolveAgentBrowserPrerequisite } from '@/components/browser/launchpad/BrowserLaunchpad';
import { useBrowserStreamedChrome } from '@/components/browser/streamed/BrowserStreamedSurfaceScope';
import type {
    BrowserControlState,
    BrowserControlViewState,
    BrowserViewLifecycleSignal,
    BrowserViewLifecycleTarget,
} from '@/sync/domains/browser/control';
import type { ImageAnnotator } from '@/components/ui/media/annotation';
import {
    BrowserAnnotatorBar,
    BrowserAnnotatorMount,
    BrowserAnnotatorPendingGlyph,
    BrowserAnnotatorStage,
    useBrowserAnnotatorSession,
    useBrowserAnnotatorStageControl,
} from '@/components/browser/annotation/BrowserAnnotator';
import {
    useBrowserAnnotationController,
    type BrowserShellContextState,
} from '@/components/browser/annotation/useBrowserAnnotationController';
import { selectBrowserDiagnosticsForView, createBrowserDiagnosticsUiStore } from '@/sync/domains/browser/diagnostics/store';
import type { BrowserDiagnosticsPanelProjection } from '@/sync/domains/browser/diagnostics';
import type { BrowserRecordingState } from '@/sync/domains/browser/recording';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
import { selectLocalServicePreviewByBrowserTarget, type LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { useLocalServicePreviewStateController } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import { buildLocalServiceCopyUrlRequest, readLocalServiceCopyDestination } from '@/components/sessions/localServices/lifecycleActions';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    usePluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import type {
    PluginBrowserActionProjection,
    PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/actions';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import {
    resolveExternalUrlTargetFromInput,
    selectActiveBrowserView,
    selectBrowserToolbarModel,
    selectBrowserViewAddress,
    selectBrowserViewDisplayHost,
} from '@/sync/domains/browser/shell';
import { type BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { canOpenDesktopBrowserDevtools, type DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { selectBrowserTargetAdapter } from '@/sync/domains/browser/adapters/selection';
import { evaluateBrowserTargetPolicy } from '@/sync/domains/browser/policy/evaluate';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import type { BrowserControlCommandEffect } from '@/sync/domains/browser/control';
import type { BrowserSurfaceLifecycleState } from './surfaces/browserSurfaceLifecycle';

import { BrowserUrlField, type BrowserUrlFieldHandle } from './BrowserUrlField';
import { useBrowserKeyboardShortcuts } from './useBrowserKeyboardShortcuts';
import { BrowserLoadProgressBar } from './BrowserLoadProgressBar';
import {
    BrowserDiagnosticsDrawer,
    type BrowserDiagnosticsDrawerHandle,
    type BrowserDiagnosticsInteractionControls,
    type BrowserDiagnosticsRuntimeProjection,
} from './diagnostics';
import {
    BrowserToolbarOverflowMenu,
    type BrowserToolbarOverflowItem,
    SecurityOriginIndicator,
} from './toolbar';
import { useBrowserToolbarOverflowItems } from './toolbar/useBrowserToolbarOverflowItems';
import { useBrowserPluginActions } from './useBrowserPluginActions';
import { BROWSER_CHROME_WIDTH, BROWSER_PAGE_BASIS, resolveBrowserChromeControlMetrics, useBrowserChromeDensity } from './browserChromeDensity';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { BrowserStatusBar } from './BrowserStatusBar';
import { BrowserToolbar } from './BrowserToolbar';
import type { BrowserViewportEmulationV1 } from '@happier-dev/protocol/browser/input/v1';
import { BrowserViewportPicker, browserViewportChoices, selectedBrowserViewportChoiceId } from './BrowserViewportPicker';
import { BrowserViewHost } from './BrowserViewHost';
import { useCheckoutReachability, type CheckoutMachineScope } from '@/components/workspaces/reachability/checkoutReachability';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import type { BrowserOpenExternalAvailability } from '@/sync/domains/browser/actions/openExternal';
import type { BrowserStreamedPageRect, BrowserStreamedSurfaceRuntime } from './adapters/BrowserStreamedTarget';
import { BrowserPluginActionPlacements } from './BrowserPluginActionPlacements';
import { BrowserShellPresence, type BrowserShellAgentPresence } from './copresence/BrowserShellPresence';
import { RemoteViewerHandBackScope } from '@/components/stream/RemoteViewerControlBar';
import { BrowserFirstUseConnecting } from './streamed/BrowserFirstUseConnecting';
import type { BrowserSandboxInstallOutcome } from '@/sync/domains/browser/firstUse/browserFirstUse';
import {
    useSessionViewerBodyPresentation,
    useSessionViewerFloatFromDock,
    type SessionViewerSourceNavigation,
} from '@/components/sessions/viewer/SessionViewerController';
import { type BrowserProfileStatusModel } from './profile/BrowserProfileStatus';
import { BrowserPrivacyPopover } from './profile/BrowserPrivacyPopover';
import { shouldSurfaceBrowserPrivacy } from './profile/browserPrivacyVisibility';
import type { BrowserDiagnosticsEngineBridgeConfig } from './frame/types';
import type { OpenBrowserViewTarget } from './surfaces/openBrowserTargetInWorkspace';
import { useBrowserPreviewRecovery } from './useBrowserPreviewRecovery';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import {
    BrowserRecordingCapsule,
    resolveBrowserRecordingControl,
    type BrowserRecordingControlInput,
    type BrowserRecordingStartControlRequest,
} from './recording';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { usePaneHeaderSlotBinding, usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { getPreferredLanguage } from '@/text';
import { isFindSurfaceTarget } from '@/keyboard/findSurfaceTarget';

const stylesheet = StyleSheet.create((theme) => ({
    // No box of its own: the pane or the Details column owns separation, the page is the hero.
    //
    // The short-pane rule (one column, page first, nothing overlaps): the chrome rows (address bar,
    // diagnostics header, bottom bar) keep their height; the page, the diagnostics body and every
    // plugin panel are the flexible regions and yield TOGETHER, each in proportion to its size, so
    // none is starved to zero; each clips or scrolls inside its own box. Plugin panels render inside
    // this column (`panels`), above the bottom bar, so no sibling can be painted over Browser chrome.
    // No fill of its own: the pane that holds the Browser owns its material (glass or solid). A page-colour fill
    // here covered a glass panel with an opaque slab (owner 2026-11-11 desktop #13).
    root: {
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
    },
    // One quiet row that recedes (lab `browser` Q): plain navigation glyphs, the address capsule with
    // its trust glyph inside, Mark up, Attach page and `⋯`. It never wraps; a running recording docks
    // here as a capsule and leaves when it stops, so nothing ever adds a second row.
    toolbarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'nowrap',
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    addressFieldSlot: {
        // Priority slot: never collapses below a usable width, so the secondary controls shrink
        // before the address input does.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: BROWSER_CHROME_WIDTH.addressFloor,
        minWidth: 0,
        marginHorizontal: theme.space.s4,
    },
    // The page and its in-page controls. Its basis is the share the diagnostics drawer leaves it, so
    // on a short pane it yields alongside the drawer body and the plugin panels instead of being the
    // only region that gives way; it grows into whatever room is left and clips its own content.
    viewHost: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: BROWSER_PAGE_BASIS,
        minHeight: 0,
        overflow: 'hidden',
    },
    pageContent: {
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
    },
    // Phone (lab `browser` Qp): the host capsule alone at the top, no rule under it — the page begins
    // where the capsule's breathing room ends.
    phoneTopBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s6,
        paddingBottom: theme.space.s8,
        backgroundColor: theme.colors.surface.base,
    },
    phoneAddressSlot: {
        flex: 1,
        minWidth: 0,
    },
    // The page controls in thumb reach. It sits in flow under the page (an embedded page can still
    // scroll its last row into view) and, when the session cockpit floats over this screen without
    // reserving its own height, above that cockpit.
    phoneBottomBar: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 48,
        paddingHorizontal: theme.space.s8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
}));

function createCommandId(kind: BrowserCommandV1['kind'], viewId: string): string {
    return `browser_command:${viewId}:${kind}:${Date.now()}`;
}

/**
 * Re-exported from the annotation controller that owns it. Four session-runtime modules import
 * this type from `BrowserShell`; the seam stays where their imports already point.
 */
export type { BrowserShellContextState };

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
    onViewAttached?: (view: Pick<BrowserRecordingSessionV1, 'browserSessionId' | 'viewId'>) => (() => void) | undefined;
    onUnavailable?: (reason: Readonly<{ reasonCode: string; message: string }>) => void;
    isCaptureSourceAvailable?: BrowserRecordingControlInput['isCaptureSourceAvailable'];
}>;

export type BrowserShellAutomationState = Readonly<{
    controlService: BrowserAutomationControlService;
    engineBridge?: BrowserDiagnosticsEngineBridgeConfig | null;
    enabled?: boolean;
    supportedActions?: readonly string[];
    nowMs?: () => number;
    onRegistrationRejected?: (reasonCode: string) => void;
    onRejectedMessage?: (reasonCode: string) => void;
}>;

export type BrowserShellProfileState = BrowserProfileStatusModel;

function resolveActiveDiagnosticsBridge(input: Readonly<{
    activeView: ReturnType<typeof selectActiveBrowserView>;
    bridge?: BrowserDiagnosticsEngineBridgeConfig | null;
}>): BrowserDiagnosticsEngineBridgeConfig | undefined {
    const activeView = input.activeView;
    const bridge = input.bridge;
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

/**
 * R-3: why "Open in your browser" is greyed out, as a sentence like the menu's other reasons, in the
 * words the Services and preview states already use (the full ended-card sentence is too long here).
 */
const EMPTY_LAUNCHPAD_ROWS: readonly BrowserLaunchpadRow[] = Object.freeze([]);

function describeOpenInYourBrowserRefusal(
    refusal: Extract<BrowserOpenExternalAvailability, { enabled: false }>,
): string {
    switch (refusal.reasonCode) {
        case 'service_stopped':
            // The ended card's sentence when the Service is known by name ("Lumen web stopped.").
            return refusal.serviceName
                ? t('browserShell.unavailable.previewEndedServiceStopped', { service: refusal.serviceName })
                : t('localServices.actions.failure.serviceNotRunning', { servicesActionOffered: true });
        case 'service_failed':
            return t('localServices.actions.failure.startFailed');
        case 'preview_ended':
            return t('browserShell.unavailable.previewEndedTitle');
        default:
            return resolveReasonCopy({ kind: 'browserFrame', reasonCode: refusal.reasonCode }).body;
    }
}

const pageCoveredByApp = () => true;

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
    interactionEnabled?: boolean;
    onCommand: (command: BrowserCommandV1) => void | Promise<ActionExecuteResult>;
    onCheckAgain?: (view: Readonly<{ browserSessionId: string; viewId: string }>) => Promise<ActionExecuteResult>;
    /** Allow the managed browser's sandbox on the Session's Machine; null when the person declined. */
    onAllowBrowserSandbox?: () => Promise<BrowserSandboxInstallOutcome | null>;
    onOpenInSystemBrowser?: (view: Readonly<{ browserSessionId: string; viewId: string }>) => void | Promise<ActionExecuteResult>;
    /** Opens the sign-in import for the managed profile in view; absent where the host has no Machine for it. */
    onImportLogins?: (view: Readonly<{ browserSessionId: string; viewId: string; profileId: string; profileName: string | null }>) => void;
    onOpenDevtools?: (view: Readonly<{ browserSessionId: string; viewId: string }>) => void | Promise<ActionExecuteResult>;
    /**
     * B-2 cause-2: a sink the in-app render engines call to feed their page-load lifecycle
     * (iframe `onLoad`/`onError`, RN `onLoadStart`/`onLoadEnd`/`onError`, desktop `publishPageInfo`)
     * back to the control reducer so a URL-bearing open transitions `loading → ready/failed`. The
     * state owner (`BrowserSurfaceHost`) supplies it; when absent, engines simply report nothing.
     */
    onViewLifecycle?: (target: BrowserViewLifecycleTarget, signal: BrowserViewLifecycleSignal) => void;
    lifecycleState?: BrowserSurfaceLifecycleState;
    launchpadRows?: readonly BrowserLaunchpadRow[];
    localServiceTargets?: readonly import('@/sync/domains/local/services/launch').LocalServiceLaunchTarget[];
    launchpadRefreshStatus?: 'idle' | 'refreshing' | 'error';
    launchpadRefreshError?: string | null;
    onRefreshLaunchpad?: () => void;
    onOpenTarget?: OpenBrowserViewTarget;
    /**
     * A phone page with no tab strip (lab Qp): the strip's + and × move into the page's ⋯, and the
     * page's own Close tab closes this tab rather than only its view.
     */
    onOpenNewTab?: () => void;
    onCloseTab?: () => void;
    /**
     * OWNER-NAV (DV-NAV): navigate the CURRENT tab in place (the launchpad/new-tab URL entry uses
     * this). Distinct from `onOpenTarget`, which opens a NEW workspace tab and is reserved for
     * external surfaces (Services rows, session-header button).
     */
    onNavigateInPlace?: OpenBrowserViewTarget;
    browserFeatureDecision?: FeatureDecision | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    openExternalAvailability?: BrowserOpenExternalAvailability;
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
    /** The live stream of the agent's browser for streamed views (the daemon owns the producer). */
    streamedBrowserRuntime?: BrowserStreamedSurfaceRuntime | null;
    browserContext?: BrowserShellContextState | null;
    browserDiagnostics?: BrowserShellDiagnosticsState | null;
    browserAutomation?: BrowserShellAutomationState | null;
    /** Mounted transport availability only; command admission remains Action-owned. */
    daemonControlAvailable?: boolean;
    /** This Session's Machine can run the managed Browser, so an embedded page may switch to it. */
    managedBrowserAvailable?: boolean;
    /** The Machine this Browser's previews and managed pages run on; its reachability is the shared owner's. */
    machine?: CheckoutMachineScope | null;
    /**
     * The session whose agent drives this browser, so the presence capsule, the cursor badge and the
     * streamed states name it (and know whether its turn is running). Independent of in-app
     * automation: a daemon-owned view is the agent's browser even when in-app automation is off.
     */
    agent?: BrowserShellAgentPresence | null;
    browserRecording?: BrowserShellRecordingState | null;
    browserProfile?: BrowserShellProfileState | null;
    navigationEffect?: BrowserControlCommandEffect | null;
    supplementalDiagnostics?: BrowserDiagnosticsPanelProjection | null;
    searchUrlTemplate?: string;
    /**
     * Panels that belong to this column (the host's plugin `browserPanel` placements). They render
     * beneath the diagnostics drawer and above the status and bottom bars, and share the column's
     * short-pane yielding with the page and the drawer body.
     */
    panels?: React.ReactNode;
    nowMs?: () => number;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-shell';
    const { theme } = useUnistyles();
    // Measured CONTAINER width, not the window: the same shell renders into a ~380px session panel
    // and a 2560px window on one machine, and only the container knows which.
    const chromeDensity = useBrowserChromeDensity();
    // 0 unless the session cockpit floats over this screen without reserving its height itself.
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    // Where a streamed page is drawn (it is letterboxed): the agent cursor maps its target into it.
    // Reported by the streamed target only when the fit changes (a new connection or a resize).
    const [streamedPageRect, setStreamedPageRect] = React.useState<BrowserStreamedPageRect | null>(null);
    const activeView = selectActiveBrowserView(props.state, props.browserSessionId, props.viewId);
    const browserDiagnostics = props.browserDiagnostics === undefined
        ? null
        : props.browserDiagnostics;
    const activeViewNavigationKey = activeView
        ? `${activeView.viewId}:${activeView.navigationGeneration}`
        : '';
    const toolbar = selectBrowserToolbarModel(activeView, props.interactionEnabled !== false);
    const activeSession = props.state.sessionsById[props.browserSessionId] ?? null;
    const launchpadRows = props.launchpadRows ?? EMPTY_LAUNCHPAD_ROWS;
    const plugins = useBrowserPluginActions({
        platform: props.platform,
        ...(props.browserProfile?.profile?.storageMode
            ? { profileStorageMode: props.browserProfile.profile.storageMode }
            : {}),
        ...(props.pluginBrowserPolicyContext ? { policyContext: props.pluginBrowserPolicyContext } : {}),
        uiProjection: props.pluginUiProjection,
        browserProjection: props.pluginBrowserProjection,
        activeView,
        ...(props.onPluginBrowserAction ? { onAction: props.onPluginBrowserAction } : {}),
    });
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = usePluginLocalizedTextResolver({
            projection: props.pluginUiProjection,
            locale: pluginLocale,
    });
    const showLaunchpad = !activeView;
    const streamedChrome = useBrowserStreamedChrome(props.streamedBrowserRuntime ?? null);
    const streamedFirstUse = streamedChrome?.firstUse;
    const firstUseConnecting = streamedFirstUse === 'preparing' || streamedFirstUse === 'opening' ? streamedFirstUse : null;
    const activeLocalPreviewMachineId = activeView?.target.kind === 'localServicePreview'
        ? activeView.target.machineId
        : null;
    const previewController = useLocalServicePreviewStateController({
        machineId: activeLocalPreviewMachineId,
        serverId: props.localServicePreviewServerId,
        enabled: props.localServicePreviewState === undefined,
    });
    const localServicePreviewState =
        props.localServicePreviewState !== undefined
            ? props.localServicePreviewState
            : previewController.state;
    const previewTarget = activeView?.target.kind === 'localServicePreview' ? activeView.target : null;
    const managedPreviewCopy = previewTarget !== null
        && (previewTarget.serviceTarget !== undefined || isProjectServiceDeclarationTargetIdV1(previewTarget.targetId));
    const previewCopyScope = managedPreviewCopy ? previewController.accountLifetime?.scope ?? null : null;
    const { executeForPresentation: executePreviewCopy } = useMountedActionExecution(previewCopyScope);
    const resolvePreviewCopyUrl = React.useCallback(async () => {
        if (!localServicePreviewState) return undefined;
        const target = selectLocalServicePreviewByBrowserTarget(localServicePreviewState, previewTarget)?.resource.serviceTarget;
        if (!target) return undefined;
        const result = await executePreviewCopy('localServices.actions.copyUrl', buildLocalServiceCopyUrlRequest({ target }));
        return result?.ok ? readLocalServiceCopyDestination(result.result) : undefined;
    }, [executePreviewCopy, localServicePreviewState, previewTarget]);
    // Only drawer identity/sections live in chrome. Its open body reads the event history.
    const activeDiagnostics = React.useMemo(() => activeView && browserDiagnostics
        ? selectBrowserDiagnosticsForView(createBrowserDiagnosticsUiStore(), {
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
        })
        : null, [activeView?.browserSessionId, activeView?.viewId, Boolean(browserDiagnostics)]);
    const diagnosticsBridge = resolveActiveDiagnosticsBridge({
        activeView,
        bridge: browserDiagnostics?.bridge ?? props.browserAutomation?.engineBridge,
    });
    const urlFieldRef = React.useRef<BrowserUrlFieldHandle | null>(null);
    const dispatchViewCommand = React.useCallback((kind: 'goBack' | 'goForward' | 'reload' | 'stop' | 'closeView') => {
        if (!activeView) return;
        return props.onCommand({
            kind,
            commandId: createCommandId(kind, activeView.viewId),
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
        });
    }, [activeView?.browserSessionId, activeView?.viewId, props.onCommand]);

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
        props.onCommand({
            kind: 'navigate',
            commandId: createCommandId('navigate', activeView.viewId),
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
            url,
        });
    }, [activeView, props]);

    const desktopNativeDevtoolsAvailable = Boolean(props.onOpenDevtools)
        && canOpenDesktopBrowserDevtools(activeView, props.desktopWebViewAvailability);
    const openDesktopDevtools = React.useCallback(() => {
        if (!activeView) return;
        void props.onOpenDevtools?.({
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
        });
    }, [activeView?.browserSessionId, activeView?.viewId, props.onOpenDevtools]);

    // The whole browser-context / annotation half of the shell: capture-provider selection, the
    // runtime-action-front-door dispatch path, the draft projection the overlay renders, and the
    // disabled-with-reason copy every affordance needs. One responsibility, one owner.
    const annotation = useBrowserAnnotationController({
        browserContext: props.browserContext,
        activeView,
        activeViewNavigationKey,
        desktopWebViewAvailability: props.desktopWebViewAvailability,
    });

    const annotatorSession = useBrowserAnnotatorSession(annotation);
    const [annotator, setAnnotator] = React.useState<ImageAnnotator | null>(null);
    const annotatorControl = useBrowserAnnotatorStageControl({ annotator, session: annotatorSession });
    const annotating = annotator !== null && annotatorSession !== null;

    const recordingModel = props.browserRecording ?? null;
    const onRecordingViewAttached = recordingModel?.onViewAttached;
    const recordingBrowserSessionId = activeView?.browserSessionId;
    const recordingViewId = activeView?.viewId;
    React.useEffect(() => {
        if (recordingBrowserSessionId && recordingViewId) return onRecordingViewAttached?.({
            browserSessionId: recordingBrowserSessionId, viewId: recordingViewId,
        });
    }, [onRecordingViewAttached, recordingBrowserSessionId, recordingViewId]);
    const recordingControl = React.useMemo(() => (recordingModel
        ? resolveBrowserRecordingControl({
            view: activeView,
            profileId: activeSession?.profileId ?? null,
            state: recordingModel.state,
            recordingCapabilities: recordingModel.recordingCapabilities,
            enabled: recordingModel.enabled,
            policyState: recordingModel.policyState,
            isCaptureSourceAvailable: recordingModel.isCaptureSourceAvailable,
        })
        : null), [activeSession?.profileId, activeView, recordingModel]);
    const startRecording = React.useCallback(() => {
        if (!recordingModel || !recordingControl) return;
        if (recordingControl.startRequest) {
            recordingModel.onStartRecording?.(recordingControl.startRequest);
        } else if (recordingControl.unavailable) {
            recordingModel.onUnavailable?.(recordingControl.unavailable);
        }
    }, [recordingControl, recordingModel]);
    const discardRecording = React.useCallback(() => {
        if (recordingControl?.activeRecording) recordingModel?.onCancelRecording?.(recordingControl.activeRecording);
    }, [recordingControl, recordingModel]);

    // The escape to the user's own browser: one action, in `⋯`, for any page with an address — it
    // no longer floats over the page's own controls.
    const openableUrl = activeView && (activeView.target.kind === 'externalUrl' || activeView.target.kind === 'localServicePreview' || activeView.target.kind === 'streamedBrowser')
        ? activeView.currentUrl ?? activeView.pendingUrl ?? null
        : null;
    // A page this device's browser can never open (the Machine's own localhost) is not offered at all.
    const neverOpensHere = props.openExternalAvailability?.enabled === false
        && props.openExternalAvailability.reasonCode === 'browser_view_unavailable';
    const openInYourBrowser = React.useMemo(() => (openableUrl && !neverOpensHere && activeView && props.onOpenInSystemBrowser
        ? () => { void props.onOpenInSystemBrowser?.({ browserSessionId: activeView.browserSessionId, viewId: activeView.viewId }); }
        : null), [openableUrl, neverOpensHere, activeView?.browserSessionId, activeView?.viewId, props.onOpenInSystemBrowser]);

    const [toolbarOverflowOpen, setToolbarOverflowOpen] = React.useState(false);
    const switchUrl = activeView && activeView.target.kind !== 'simulatorPreview'
        && activeView.target.kind !== 'hostedPluginWeb'
        ? activeView.currentUrl ?? activeView.pendingUrl
            ?? (activeView.target.kind === 'externalUrl' ? activeView.target.url : null)
        : null;
    const engineSwitch = React.useMemo(() => {
        if (!activeView || !switchUrl || !props.onNavigateInPlace) return null;
        const destination = isDaemonAuthoritativeBrowserView(activeView) ? 'embedded' : 'managed';
        const target = resolveExternalUrlTargetFromInput(switchUrl);
        if (!target) return null;
        // Offered only where the engine owner would honour the switch for this page.
        const selection = selectBrowserTargetAdapter({ target, platform: props.platform, engineOverride: destination,
            managedBrowserAvailable: props.managedBrowserAvailable === true,
            desktopWebViewAvailability: props.desktopWebViewAvailability,
            targetPolicyDecision: evaluateBrowserTargetPolicy({ target, profile: props.browserProfile?.profile ?? null,
                browserFeatureDecision: props.browserFeatureDecision, allowExternalUrlBrowsing: props.allowExternalUrlBrowsing ?? true }) });
        if (!selection.ok || selection.outcome !== (destination === 'managed' ? 'managedBrowser' : 'renderEngine')) return null;
        return { destination, onPress: () => {
            void props.onNavigateInPlace?.(target, { platform: props.platform, engineOverride: destination });
        } } as const;
    }, [activeView, switchUrl, props.platform, props.onNavigateInPlace, props.managedBrowserAvailable,
        props.desktopWebViewAvailability, props.browserProfile?.profile, props.browserFeatureDecision, props.allowExternalUrlBrowsing]);
    // Lab Q: idle Diagnostics live in ⋯ at every width; the drawer appears only once opened from there.
    const diagnosticsDrawerRef = React.useRef<BrowserDiagnosticsDrawerHandle>(null);
    const openDiagnostics = React.useMemo(() => (activeDiagnostics || props.supplementalDiagnostics
        ? () => diagnosticsDrawerRef.current?.open()
        : null), [activeDiagnostics, props.supplementalDiagnostics]);
    const closeView = React.useCallback(() => dispatchViewCommand('closeView'), [dispatchViewCommand]);
    // Without a tab strip, Close tab closes the tab itself (its view goes with it, as with the strip's ×).
    const closePage = props.onCloseTab ?? closeView;
    // A Session viewer docked here floats again from the page menu (the Computer pane's same entry).
    const inViewer = useSessionViewerBodyPresentation() === 'viewer';
    // N4: under a pane header (the Session side pane) the page's tools fold into that header's one ⋯,
    // so the band never carries two. A phone keeps its ⋯ in the bottom bar, where the thumb is.
    const paneHeaderOwnsMenu = usePaneHeaderSlotBinding() !== null && chromeDensity.density !== 'phone' && !inViewer;
    // One tab bar on a phone (owner ruling 2026-10-30): a Details group showing this Browser as its one page lends
    // what its strip offered (its controls; pin, close and its other pages as rows). The Browser's own chrome takes
    // them, so the strip folds on the launchpad and over a page alike, and the rows join the Browser's one `⋯`.
    const phoneChrome = chromeDensity.density === 'phone' && !inViewer;
    const lentControls = useClaimedStackHeaderActions({ scopeOnly: true, drawsMenuRows: true, release: !phoneChrome });
    const lentRows = useLentHeaderMenuRows();
    const onFloatView = useSessionViewerFloatFromDock('browser', !inViewer);
    // A managed profile the Machine runs can take imported sign-ins; an embedded or preview page cannot.
    const importProfileId = activeView && isDaemonAuthoritativeBrowserView(activeView) ? activeSession?.profileId ?? null : null;
    const onImportLogins = props.onImportLogins;
    const importLogins = React.useMemo(() => (onImportLogins && activeView && importProfileId
        ? () => onImportLogins({ browserSessionId: activeView.browserSessionId, viewId: activeView.viewId, profileId: importProfileId,
            profileName: props.browserProfile?.profile?.displayName ?? null })
        : null), [activeView?.browserSessionId, activeView?.viewId, importProfileId, onImportLogins, props.browserProfile?.profile?.displayName]);
    const overflowItems = useBrowserToolbarOverflowItems({
        engineSwitch,
        activeView,
        annotation: props.browserContext ? annotation : null,
        recording: recordingControl,
        onStartRecording: recordingModel?.onStartRecording ? startRecording : undefined,
        onDiscardRecording: recordingModel?.onCancelRecording ? discardRecording : undefined,
        onOpenInYourBrowser: openInYourBrowser,
        openInYourBrowserDisabledReason: props.openExternalAvailability?.enabled === false
            ? describeOpenInYourBrowserRefusal(props.openExternalAvailability)
            : null,
        onOpenDiagnostics: openDiagnostics,
        onOpenNewTab: props.onOpenNewTab,
        onCloseTab: props.onCloseTab,
        onFloatView,
        onImportLogins: importLogins,
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools: openDesktopDevtools,
        plugins,
        pluginActionsEnabled: Boolean(props.onPluginBrowserAction),
        // The header's menu lists its rows whenever it is drawn; the toolbar's only while it is open.
        localizePluginText: toolbarOverflowOpen || paneHeaderOwnsMenu ? localizePluginText : undefined,
    });
    // A narrow pane gives the address its room: the page size, a rare choice, moves from the row into
    // the ⋯ as its own checked set. A phone keeps it in the bottom bar; a wide row keeps its picker.
    const viewportView = props.interactionEnabled !== false && activeView && isDaemonAuthoritativeBrowserView(activeView) ? activeView : null;
    const viewportInMenu = chromeDensity.density === 'pane' && viewportView !== null;
    const viewportEmulation = streamedChrome?.viewport?.emulation ?? null;
    const selectViewport = React.useCallback((emulation: BrowserViewportEmulationV1) => {
        if (!viewportView) return;
        props.onCommand({
            kind: 'setViewport',
            commandId: createCommandId('setViewport', viewportView.viewId),
            browserSessionId: viewportView.browserSessionId,
            viewId: viewportView.viewId,
            emulation,
        });
    }, [props.onCommand, viewportView]);
    const pageMenuItems = React.useMemo((): readonly BrowserToolbarOverflowItem[] => {
        if (!viewportInMenu) return overflowItems;
        const selectedId = selectedBrowserViewportChoiceId(viewportEmulation ?? { kind: 'fitViewer' });
        const group = { id: 'browser-viewport', title: t('browserShell.viewport.title') };
        return [...overflowItems, ...browserViewportChoices().map((choice): BrowserToolbarOverflowItem => ({
            id: `browser-viewport:${choice.id}`,
            iconName: 'device-mobile',
            label: choice.title,
            subtitle: choice.subtitle,
            selected: choice.id === selectedId,
            group,
            onPress: () => selectViewport(choice.emulation),
        }))];
    }, [overflowItems, selectViewport, viewportEmulation, viewportInMenu]);
    const menuItems = React.useMemo((): readonly BrowserToolbarOverflowItem[] => {
        const rows = phoneChrome ? lentRows : null;
        if (!rows || rows.length === 0) return pageMenuItems;
        // A lending group always lends a close (its own row, or the pane's close among its controls), and that
        // close also ends the pane with its last page: it stands in for the page's own Close tab.
        // Close means the page goes with its tab: a launchpad tab's page lives in the launchpad's own Browser session,
        // so a page left open there came back tab-less (no pin, no close) the next time the Browser opened.
        return [...pageMenuItems.filter(item => item.id !== 'close-tab'), ...rows.map((row): BrowserToolbarOverflowItem => ({
            id: row.id, iconName: row.iconName, label: row.title, disabled: row.disabled,
            onPress: row.role === 'close' && activeView ? () => { void closeView(); row.onSelect(); } : row.onSelect,
        }))];
    }, [activeView, closeView, lentRows, pageMenuItems, phoneChrome]);
    // While the agent drives its own (daemon) browser the page is moving under it: the page tools
    // step out of the chrome until the person has the page (lab `browser` A/H). The controller is the
    // daemon's, already in the view state.
    const agentDrivesPage = Boolean(activeView && isDaemonAuthoritativeBrowserView(activeView)
        && activeView.automationController?.controller === 'agent');
    const onAddressEdit = React.useCallback(() => {
        if (!toolbar.canNavigate || !agentDrivesPage || !activeView?.automationController) return;
        const { browserSessionId, viewId } = activeView;
        props.onCommand({ kind: 'takeControl', commandId: createCommandId('takeControl', viewId), browserSessionId, viewId });
    }, [activeView, agentDrivesPage, props.onCommand, toolbar.canNavigate]);
    // The page tools act on the page in view. The launchpad has no page, so they are not offered there
    // (a disabled pair could only say the target cannot be opened, which is not what the launchpad is).
    const browserContextPresent = Boolean(props.browserContext) && Boolean(activeView) && !agentDrivesPage;
    // Ended, Can't reach and refused pages settle the view as failed and show a card: there is no page
    // to attach or mark up.
    const pageShown = activeView?.loadingState !== 'failed';
    // Like Start recording: a page that can never be captured (an embedded preview) does not offer Mark up.
    const markUpOffered = browserContextPresent && pageShown && annotation.supported
        && (!annotation.captureProducerUnavailable || annotation.editorActive);
    const markUpDisabledReason = annotation.contextButtonDisabled
        ? annotation.contextDisabledReason
        : annotation.captureProducerUnavailable
            ? annotation.captureDisabledReason
            : null;
    const toggleMarkUp = React.useCallback(() => {
        if (!annotation.capturePending) annotation.start();
    }, [annotation]);

    // UB-6: browser chrome shortcuts, owned by the app's one keyboard-command registry. Each is
    // registered only while the active engine can fulfil it, so a key is never swallowed by a
    // control the toolbar itself hides.
    // The Browser's own root: an Escape from inside it (the page or its chrome) is the Browser's to stop a load.
    const browserRootRef = React.useRef<View>(null);
    const browserContainsTarget = React.useCallback(
        (target: unknown) => isFindSurfaceTarget(browserRootRef.current as unknown as Element | null, target), []);
    const browserShortcutLabels = useBrowserKeyboardShortcuts({
        model: toolbar,
        containsTarget: browserContainsTarget,
        onFocusAddress: () => urlFieldRef.current?.focus(),
        onBack: () => dispatchViewCommand('goBack'),
        onForward: () => dispatchViewCommand('goForward'),
        onReload: () => dispatchViewCommand('reload'),
        onStop: () => dispatchViewCommand('stop'),
    });

    // The Session viewer presents the page itself (lab `b-watch`): no browser chrome around the
    // picture. Its Back, Forward and Reload move to the viewer's menu; the pane keeps the full shell.
    const viewerNavigation = React.useMemo<SessionViewerSourceNavigation | null>(() => (inViewer ? {
        back: toolbar.canGoBack ? () => dispatchViewCommand('goBack') : null,
        forward: toolbar.canGoForward ? () => dispatchViewCommand('goForward') : null,
        reload: toolbar.canReload ? () => dispatchViewCommand('reload') : null,
    } : null), [dispatchViewCommand, inViewer, toolbar.canGoBack, toolbar.canGoForward, toolbar.canReload]);
    const frameRecovery = useBrowserPreviewRecovery({
        activeView,
        launchpadRows,
        localServiceTargets: props.localServiceTargets,
        platform: props.platform,
        serverId: props.localServicePreviewServerId,
        accountLifetime: previewController.accountLifetime,
        credentialKey: previewController.credentialKey,
        onOpenTarget: props.onOpenTarget,
        onClose: closePage,
        canReload: toolbar.canReload,
        onCommand: dispatchViewCommand,
    });
    // Recovery opens the last page through the current-tab owner, not the stopped daemon view.
    const recoveredUrl = activeView?.target.kind === 'externalUrl' ? activeView.currentUrl ?? activeView.target.url : null;
    const recoveredPage = React.useMemo(() => recoveredUrl ? resolveExternalUrlTargetFromInput(recoveredUrl) : null, [recoveredUrl]);
    const openStreamedPageHere = React.useCallback(() => {
        if (recoveredPage) props.onNavigateInPlace?.(recoveredPage, { platform: props.platform });
    }, [props.onNavigateInPlace, props.platform, recoveredPage]);

    // H-UX §5: a phone recomposes the chrome instead of shrinking it — the address is a host capsule
    // at the top, and the page controls move to a bottom bar in thumb reach. The launchpad is its own
    // page there (lab W): it brings its own address entry, so no browser chrome surrounds it.
    const phone = chromeDensity.density === 'phone';
    const showPhoneChrome = phone && (!showLaunchpad || firstUseConnecting !== null) && !inViewer;
    const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
    const controlMetrics = resolveBrowserChromeControlMetrics(chromeDensity.density, { touch: touchPrimaryPointer });
    // On the web a typed address opens in the Machine's managed Browser. While that Machine is out of
    // reach the address can't succeed, so it isn't offered; the launchpad says why, in the shared words.
    const machineReachability = useCheckoutReachability(props.machine ?? null);
    const addressNeedsMachine = props.platform === 'web' && props.managedBrowserAvailable === true;
    const navigateInPlace = props.interactionEnabled === false || addressNeedsMachine && machineReachability.unreachable
        ? undefined : props.onNavigateInPlace;
    const addressField = (
        <BrowserUrlField
            testID={`${testID}-address`}
            focusRef={urlFieldRef}
            density={controlMetrics.addressDensity}
            trailingAction={phone ? 'none' : 'copy'}
            resolveCopyUrl={managedPreviewCopy ? resolvePreviewCopyUrl : undefined}
            clipboardScope={managedPreviewCopy ? previewCopyScope : undefined}
            formatWhileBlurred
            displayHost={selectBrowserViewDisplayHost(activeView)}
            value={selectBrowserViewAddress(activeView)
                ?? (firstUseConnecting ? streamedChrome?.firstUseTargetUrl : undefined) ?? ''}
            disabled={activeView ? !toolbar.canNavigate : !navigateInPlace}
            onEditStart={onAddressEdit}
            editIntentKey={activeView ? JSON.stringify([activeView.browserSessionId, activeView.viewId,
                activeView.automationController?.controller, activeView.automationController?.controlEpoch]) : undefined}
            {...(props.searchUrlTemplate ? { searchUrlTemplate: props.searchUrlTemplate } : {})}
            leading={(
                <SecurityOriginIndicator
                    testID={`${testID}-security`}
                    view={activeView}
                    compact
                />
            )}
            onSubmitUrl={dispatchNavigate}
        />
    );
    const recordingCapsule = recordingControl?.activeRecording ? (
        <BrowserRecordingCapsule
            testID={`${testID}-recording`}
            recording={recordingControl.activeRecording}
            onStop={recordingModel?.onStopRecording}
        />
    ) : null;
    const markUpButton = markUpOffered ? (
        <IconButton
            testID={`${testID}-mark-up`}
            {...(annotation.capturePending ? { icon: <BrowserAnnotatorPendingGlyph /> } : { iconName: 'pencil-circle' as const })}
            variant="plain"
            iconSize={controlMetrics.iconSize}
            accessibilityLabel={t('browserContext.composer.startAnnotation')}
            tooltip={t('browserContext.composer.startAnnotation')}
            selected={annotation.capturePending}
            disabled={markUpDisabledReason !== null}
            disabledReason={markUpDisabledReason ?? undefined}
            size={controlMetrics.size}
            interactiveTargetGapPx={phone ? undefined : 4}
            onPress={toggleMarkUp}
        />
    ) : null;
    const attachPageButton = browserContextPresent && pageShown ? (
        chromeDensity.collapsed ? (
            <IconButton
                testID={`${testID}-attach-page`}
                iconName="paperclip"
                variant="plain"
                iconSize={controlMetrics.iconSize}
                accessibilityLabel={t('browserContext.composer.attachPageReference')}
                tooltip={t('browserContext.composer.attachPageReference')}
                disabled={annotation.contextButtonDisabled}
                disabledReason={annotation.contextDisabledReason ?? undefined}
                size={controlMetrics.size}
                interactiveTargetGapPx={phone ? undefined : 4}
                onPress={annotation.attachPageReference}
            />
        ) : (
            <RoundButton
                testID={`${testID}-attach-page`}
                size="small"
                display="secondary"
                title={t('browserContext.composer.attachPageReference')}
                leading={<Icon name="paperclip" size={ICON_SIZE.xs} color={theme.colors.text.primary} />}
                disabled={annotation.contextButtonDisabled}
                accessibilityHint={annotation.contextDisabledReason ?? undefined}
                onPress={annotation.attachPageReference}
            />
        )
    ) : null;
    const privacyControl = props.browserProfile && shouldSurfaceBrowserPrivacy(props.browserProfile) ? (
        <BrowserPrivacyPopover
            testID={`${testID}-privacy`}
            model={props.browserProfile}
        />
    ) : null;
    const overflowMenu = paneHeaderOwnsMenu ? <BrowserPaneHeaderMenuPublisher items={menuItems} /> : (
        <BrowserToolbarOverflowMenu
            testID={`${testID}-overflow`}
            items={menuItems}
            onOpenChange={setToolbarOverflowOpen}
            size={controlMetrics.size}
            iconSize={controlMetrics.iconSize}
            spread={phone}
            placement={phone ? 'top' : 'bottom'}
        />
    );
    const viewportPicker = viewportView && !viewportInMenu ? (
        <BrowserViewportPicker
            testID={`${testID}-viewport`}
            emulation={streamedChrome?.viewport?.emulation ?? { kind: 'fitViewer' }}
            size={controlMetrics.size}
            iconSize={controlMetrics.iconSize}
            spread={phone}
            onSelect={(emulation) => props.onCommand({
                kind: 'setViewport',
                commandId: createCommandId('setViewport', viewportView.viewId),
                browserSessionId: viewportView.browserSessionId,
                viewId: viewportView.viewId,
                emulation,
            })}
        />
    ) : null;
    const navigationControls = (
        <BrowserToolbar
            testID={testID}
            model={toolbar}
            shortcutLabels={browserShortcutLabels}
            controlSize={controlMetrics.size}
            iconSize={controlMetrics.iconSize}
            spread={phone}
            onBack={() => dispatchViewCommand('goBack')}
            onForward={() => dispatchViewCommand('goForward')}
            onReload={() => dispatchViewCommand('reload')}
            onStop={() => dispatchViewCommand('stop')}
        >
            {phone ? <>{markUpButton}{attachPageButton}{viewportPicker}{overflowMenu}</> : null}
        </BrowserToolbar>
    );

    // The retained Browser body mounts outside the details workspace, so it takes its state step here:
    // the page's states (Ended, Can't reach, Start failed) read at the pane's measure, as the lab draws them.
    // The page is arbitrary pixels under the chrome, so the popovers and menus it opens take the live-picture coat.
    return (
        <GlassLivePictureBackdropContext.Provider value>
        <SurfaceStateSizeProvider size={phone ? 'phone' : 'details'}>
        <RemoteViewerHandBackScope>
        <View ref={browserRootRef} testID={testID} style={stylesheet.root} onLayout={chromeDensity.onLayout}>
            {annotatorSession ? <BrowserAnnotatorMount session={annotatorSession} onAnnotator={setAnnotator} /> : null}
            {annotating ? (
                <View
                    testID={`${testID}-annotator-bar`}
                    style={phone ? stylesheet.phoneTopBar : [stylesheet.toolbarRow, { height: controlMetrics.size + controlMetrics.rowPaddingVerticalPx * 2, paddingVertical: 0 }]}
                >
                    <BrowserAnnotatorBar annotator={annotator} phone={phone} onClose={annotatorControl.close} attach={annotatorControl.attach} escapeScope={annotatorControl.escapeScope} />
                </View>
            ) : inViewer ? null : phone ? (showPhoneChrome ? (
                <View testID={`${testID}-top-bar`} style={stylesheet.phoneTopBar}>
                    <View style={stylesheet.phoneAddressSlot}>{addressField}</View>
                    {recordingCapsule}
                    {privacyControl}
                    {lentControls}
                </View>
            ) : null) : (
                <View style={[stylesheet.toolbarRow, { paddingVertical: controlMetrics.rowPaddingVerticalPx }]}>
                    {navigationControls}
                    <View style={stylesheet.addressFieldSlot}>{addressField}</View>
                    {recordingCapsule}
                    {markUpButton}
                    {attachPageButton}
                    {privacyControl}
                    {viewportPicker}
                    {overflowMenu}
                </View>
            )}
            <View style={stylesheet.viewHost}>
                <View testID={`${testID}-page-region`} style={stylesheet.pageContent}>
                <BrowserLoadProgressBar
                    testID={`${testID}-load-progress`}
                    progress={activeView?.loadingProgress ?? null}
                    loadingState={activeView?.loadingState ?? 'idle'}
                />
                {showLaunchpad && firstUseConnecting ? (
                    <BrowserFirstUseConnecting
                        testID={`${testID}-first-use`}
                        firstUse={firstUseConnecting}
                        machineName={streamedChrome?.machineName ?? null}
                        agent={props.agent ?? null}
                    />
                ) : showLaunchpad ? (
                    <BrowserLaunchpad
                        previewAccountLifetime={previewController.accountLifetime}
                        previewCredentialKey={previewController.credentialKey}
                        testID={`${testID}-launchpad`}
                        rows={launchpadRows}
                        platform={props.platform}
                        browserProfile={props.browserProfile?.profile ?? null}
                        browserFeatureDecision={props.browserFeatureDecision}
                        desktopWebViewAvailability={props.desktopWebViewAvailability}
                        allowExternalUrlBrowsing={props.allowExternalUrlBrowsing}
                        refreshStatus={props.launchpadRefreshStatus ?? 'idle'}
                        refreshError={props.launchpadRefreshError}
                        onRefresh={props.onRefreshLaunchpad}
                        localServicePreviewServerId={props.localServicePreviewServerId}
                        agentBrowser={resolveAgentBrowserPrerequisite(streamedChrome, props.agent ?? null,
                            props.onAllowBrowserSandbox)}
                        onOpenTarget={props.onOpenTarget}
                        onNavigateInPlace={navigateInPlace}
                        machineReachability={machineReachability}
                        // The wide chrome's address bar is this page's one address field; a phone page
                        // and the Session viewer draw no chrome, so the launchpad brings its own.
                        urlEntry={phone || inViewer}
                        // The phone launchpad has no bottom bar: its address row carries the Browser's one `⋯`.
                        urlEntryTrailing={phoneChrome ? <>{lentControls}{menuItems.length > 0 ? overflowMenu : null}</> : undefined}
                    />
                ) : (
                    <BrowserViewHost
                        onOpenInSystemBrowser={openInYourBrowser ?? undefined}
                        testID={`${testID}-view`}
                        view={activeView}
                        onViewLifecycle={props.onViewLifecycle}
                        lifecycleState={props.lifecycleState}
                        occlusionProbe={annotating ? pageCoveredByApp : undefined}
                        localServicePreviewState={localServicePreviewState}
                        localServicePreviewServerId={props.localServicePreviewServerId}
                        pluginUiProjection={props.pluginUiProjection}
                        projectionInteractionEnabled={props.pluginUiInteractionEnabled}
                        simulatorPreviewRuntime={props.simulatorPreviewRuntime}
                        navigationEffect={props.navigationEffect}
                        diagnosticsBridge={diagnosticsBridge}
                        browserAutomation={props.browserAutomation}
                        browserProfile={props.browserProfile?.profile ?? null}
                        streamedBrowserRuntime={props.streamedBrowserRuntime}
                        onStreamedPageRectChange={setStreamedPageRect}
                        onOpenStreamedPageHere={recoveredPage && props.onNavigateInPlace ? openStreamedPageHere : undefined}
                        onClosePage={closePage}
                        recovery={frameRecovery}
                        agent={props.agent ?? null}
                        nowMs={props.nowMs}
                    />
                )}
                {annotating ? (
                    <BrowserAnnotatorStage annotator={annotator} session={annotatorSession} phone={phone} control={annotatorControl} />
                ) : null}
                </View>
                {activeView && (isDaemonAuthoritativeBrowserView(activeView)
                    || (props.browserAutomation && props.browserAutomation.enabled !== false)) ? (
                    <BrowserShellPresence
                        viewerNavigation={viewerNavigation}
                        onClosePage={closePage}
                        testID={`${testID}-presence`}
                        view={activeView}
                        controlService={props.browserAutomation && props.browserAutomation.enabled !== false
                            ? props.browserAutomation.controlService
                            : null}
                        onCommand={isDaemonAuthoritativeBrowserView(activeView)
                            && !(props.daemonControlAvailable ?? Boolean(props.browserContext?.daemonControl?.sendCommand))
                            ? undefined : props.onCommand}
                        onCheckAgain={props.onCheckAgain}
                        agent={props.agent ?? null}
                        pageRect={streamedPageRect}
                        viewerControlling={streamedChrome?.viewerControlling ?? null}
                        compact={chromeDensity.collapsed}
                        nowMs={props.browserAutomation?.nowMs ?? props.nowMs}
                    />
                ) : null}
            </View>
            {activeView && props.onPluginBrowserAction && !inViewer ? (
                <BrowserPluginActionPlacements
                    detailsPanelActions={plugins.detailsPanelActions}
                    contextMenuActions={plugins.contextMenuActions}
                    policyContext={plugins.policyContext}
                    pluginUiProjection={props.pluginUiProjection}
                    onAction={plugins.invokeAction}
                    testID={`${testID}-plugin-action`}
                />
            ) : null}
            {/*
              * ONE drawer. The preview-proxy projection used to mount a SECOND
              * `BrowserDiagnosticsDrawer` directly beneath the first, with the same "Diagnostics"
              * title on both, and no way to tell which panel belonged to which source. It is a
              * section of this drawer now; when there is no host projection it is the only section,
              * so the capability is unchanged.
              */}
            {!inViewer && (activeDiagnostics || props.supplementalDiagnostics) ? (
                <BrowserDiagnosticsDrawer
                    diagnostics={activeDiagnostics ?? props.supplementalDiagnostics!}
                    state={browserDiagnostics?.eventSource ? undefined : browserDiagnostics?.state}
                    eventSource={browserDiagnostics?.eventSource}
                    diagnosticsAvailability={browserDiagnostics?.diagnosticsAvailability}
                    daemonSnapshot={browserDiagnostics?.daemonSnapshot}
                    supplemental={activeDiagnostics ? props.supplementalDiagnostics : null}
                    interaction={browserDiagnostics?.interaction}
                    surfaceHeightPx={chromeDensity.containerHeightPx ?? undefined}
                    handleRef={diagnosticsDrawerRef}
                    testID={`${testID}-diagnostics`}
                />
            ) : null}
            {props.panels}
            <BrowserStatusBar
                testID={`${testID}-status`}
                view={activeView}
                onRetry={toolbar.canReload ? () => dispatchViewCommand('reload') : undefined}
            />
            {showPhoneChrome && !annotating ? (
                <View
                    testID={`${testID}-bottom-bar`}
                    accessibilityRole="toolbar"
                    style={[stylesheet.phoneBottomBar, bottomChromeHeight > 0 ? { paddingBottom: bottomChromeHeight } : null]}
                >
                    {navigationControls}
                </View>
            ) : null}
        </View>
        </RemoteViewerHandBackScope>
        </SurfaceStateSizeProvider>
        </GlassLivePictureBackdropContext.Provider>
    );
}

/** The page's tools as the pane header's ⋯ rows: the same items, labels, reasons and order the toolbar's ⋯ had. */
function BrowserPaneHeaderMenuPublisher(props: Readonly<{ items: readonly BrowserToolbarOverflowItem[] }>): null {
    const { items } = props;
    usePaneHeaderSlotContent(React.useMemo(() => ({
        menuActions: items.map((item): ItemAction => ({
            id: item.id,
            title: item.label,
            subtitle: item.disabled && item.disabledReason ? item.disabledReason : item.subtitle,
            icon: item.iconName,
            onPress: item.disabled ? undefined : item.onPress,
            disabled: item.disabled,
            destructive: item.destructive,
            ...(item.selected === undefined ? {} : { selected: item.selected }),
            ...(item.group ? { group: item.group } : {}),
        })),
    }), [items]));
    return null;
}
