import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
    BrowserCommandV1,
    BrowserPlatformV1,
    BrowserRecordingCapabilities,
    BrowserRecordingPolicyStateV1,
    BrowserRecordingSessionV1,
    FeatureDecision,
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
import { AnnotationEditorOverlay } from '@/components/browser/annotation';
import {
    useBrowserAnnotationController,
    type BrowserShellContextState,
} from '@/components/browser/annotation/useBrowserAnnotationController';
import {
    selectBrowserDiagnosticsForView,
    createBrowserDiagnosticsUiStore,
    type BrowserDiagnosticsPanelProjection,
} from '@/sync/domains/browser/diagnostics';
import type { BrowserRecordingState } from '@/sync/domains/browser/recording';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    createPluginLocalizedTextResolver,
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
} from '@/sync/domains/browser/shell';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { openDesktopBrowserDevtools } from '@/sync/domains/browser/adapters/desktopWebViewBridge';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import type { BrowserControlCommandEffect } from '@/sync/domains/browser/control';
import type { BrowserSurfaceLifecycleState } from './surfaces/browserSurfaceLifecycle';

import { BrowserUrlField, type BrowserUrlFieldHandle } from './BrowserUrlField';
import { useBrowserKeyboardShortcuts } from './useBrowserKeyboardShortcuts';
import { BrowserLoadProgressBar } from './BrowserLoadProgressBar';
import {
    BrowserDiagnosticsDrawer,
    type BrowserDiagnosticsInteractionControls,
    type BrowserDiagnosticsRuntimeProjection,
} from './diagnostics';
import {
    BrowserToolbarOverflowMenu,
    SecurityOriginIndicator,
} from './toolbar';
import { useBrowserToolbarOverflowItems } from './toolbar/useBrowserToolbarOverflowItems';
import { useBrowserPluginActions } from './useBrowserPluginActions';
import { BROWSER_CHROME_WIDTH, resolveBrowserChromeControlMetrics, useBrowserChromeDensity } from './browserChromeDensity';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { BrowserStatusBar } from './BrowserStatusBar';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserViewHost } from './BrowserViewHost';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import type { BrowserStreamedPageRect, BrowserStreamedSurfaceRuntime } from './adapters/BrowserStreamedTarget';
import { BrowserPluginActionPlacements } from './BrowserPluginActionPlacements';
import { BrowserShellPresence, type BrowserShellAgentPresence } from './copresence/BrowserShellPresence';
import { type BrowserProfileStatusModel } from './profile/BrowserProfileStatus';
import { BrowserPrivacyPopover } from './profile/BrowserPrivacyPopover';
import { shouldSurfaceBrowserPrivacy } from './profile/browserPrivacyVisibility';
import type { BrowserDiagnosticsEngineBridgeConfig } from './frame/types';
import {
    BrowserRecordingCapsule,
    resolveBrowserRecordingControl,
    type BrowserRecordingControlInput,
    type BrowserRecordingStartControlRequest,
} from './recording';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
    buildOpenExternalTabSelection,
    openBrowserExternalTabSelection,
} from '@/sync/domains/browser/adapters/selection';
import { t } from '@/text';
import { getPreferredLanguage } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    // No box of its own: the pane or the Details column owns separation, the page is the hero.
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    // One quiet row that recedes (lab `browser` Q): plain navigation glyphs, the address capsule with
    // its trust glyph inside, Mark up, Attach page and `⋯`. It never wraps; a running recording docks
    // here as a capsule and leaves when it stops, so nothing ever adds a second row.
    toolbarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'nowrap',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    addressFieldSlot: {
        // Priority slot: never collapses below a usable width, so the secondary controls shrink
        // before the address input does.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: BROWSER_CHROME_WIDTH.addressFloor,
        minWidth: 0,
        marginHorizontal: 4,
    },
    viewHost: {
        flex: 1,
        minHeight: 0,
    },
    // Phone (lab `browser` Qp): the host capsule alone at the top, no rule under it — the page begins
    // where the capsule's breathing room ends.
    phoneTopBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 6,
        paddingBottom: 8,
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
        paddingHorizontal: 8,
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
    lifecycleState?: BrowserSurfaceLifecycleState;
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
    /** The live stream of the agent's browser for streamed views (the daemon owns the producer). */
    streamedBrowserRuntime?: BrowserStreamedSurfaceRuntime | null;
    browserContext?: BrowserShellContextState | null;
    browserDiagnostics?: BrowserShellDiagnosticsState | null;
    browserAutomation?: BrowserShellAutomationState | null;
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
    const toolbar = selectBrowserToolbarModel(activeView);
    const activeSession = props.state.sessionsById[props.browserSessionId] ?? null;
    const launchpadRows = props.launchpadRows ?? [];
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
    const localizePluginText = React.useMemo(
        () => createPluginLocalizedTextResolver({
            projection: props.pluginUiProjection,
            locale: pluginLocale,
        }),
        [pluginLocale, props.pluginUiProjection],
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

    // The whole browser-context / annotation half of the shell: capture-provider selection, the
    // runtime-action-front-door dispatch path, the draft projection the overlay renders, and the
    // disabled-with-reason copy every affordance needs. One responsibility, one owner.
    const annotation = useBrowserAnnotationController({
        browserContext: props.browserContext,
        activeView,
        activeViewNavigationKey,
        desktopWebViewAvailability: props.desktopWebViewAvailability,
    });

    const recordingModel = props.browserRecording ?? null;
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
    const openableUrl = activeView && (activeView.target.kind === 'externalUrl' || activeView.target.kind === 'localServicePreview')
        ? activeView.currentUrl ?? activeView.pendingUrl ?? null
        : null;
    const openInYourBrowser = React.useMemo(() => (openableUrl
        ? () => { void openBrowserExternalTabSelection(buildOpenExternalTabSelection(openableUrl)); }
        : null), [openableUrl]);

    const overflowItems = useBrowserToolbarOverflowItems({
        activeView,
        annotation: props.browserContext ? annotation : null,
        recording: recordingControl,
        onStartRecording: recordingModel?.onStartRecording ? startRecording : undefined,
        onDiscardRecording: recordingModel?.onCancelRecording ? discardRecording : undefined,
        onOpenInYourBrowser: openInYourBrowser,
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools: openDesktopDevtools,
        plugins,
        pluginActionsEnabled: Boolean(props.onPluginBrowserAction),
        localizePluginText,
    });
    // While the agent drives its own (daemon) browser the page is moving under it: the page tools
    // step out of the chrome until the person has the page (lab `browser` A/H). The controller is the
    // daemon's, already in the view state.
    const agentDrivesPage = Boolean(activeView && isDaemonAuthoritativeBrowserView(activeView)
        && activeView.automationController?.controller === 'agent');
    const onAddressEdit = React.useCallback(() => {
        if (!agentDrivesPage || !activeView?.automationController) return;
        const { browserSessionId, viewId } = activeView;
        props.onCommand({ kind: 'takeControl', commandId: createCommandId('takeControl', viewId), browserSessionId, viewId });
    }, [activeView, agentDrivesPage, props.onCommand]);
    const browserContextPresent = Boolean(props.browserContext) && !agentDrivesPage;
    const markUpOffered = browserContextPresent && annotation.supported;
    const markUpDisabledReason = annotation.contextButtonDisabled
        ? annotation.contextDisabledReason
        : annotation.captureProducerUnavailable
            ? annotation.captureDisabledReason
            : null;
    const toggleMarkUp = React.useCallback(() => {
        if (annotation.editorActive) annotation.cancel();
        else annotation.start();
    }, [annotation]);

    // UB-6: browser chrome shortcuts, owned by the app's one keyboard-command registry. Each is
    // registered only while the active engine can fulfil it, so a key is never swallowed by a
    // control the toolbar itself hides.
    const browserShortcutLabels = useBrowserKeyboardShortcuts({
        model: toolbar,
        onFocusAddress: () => urlFieldRef.current?.focus(),
        onBack: () => dispatchViewCommand('goBack'),
        onForward: () => dispatchViewCommand('goForward'),
        onReload: () => dispatchViewCommand('reload'),
        onStop: () => dispatchViewCommand('stop'),
    });

    // H-UX §5: a phone recomposes the chrome instead of shrinking it — the address is a host capsule
    // at the top, and the page controls move to a bottom bar in thumb reach. The launchpad is its own
    // page there (lab W): it brings its own address entry, so no browser chrome surrounds it.
    const phone = chromeDensity.density === 'phone';
    const showPhoneChrome = phone && !showLaunchpad;
    const controlMetrics = resolveBrowserChromeControlMetrics(chromeDensity.density);
    const addressField = (
        <BrowserUrlField
            testID={`${testID}-address`}
            focusRef={urlFieldRef}
            density={controlMetrics.addressDensity}
            trailingAction={phone ? 'none' : 'copy'}
            formatWhileBlurred
            value={activeView?.pendingUrl ?? activeView?.currentUrl ?? ''}
            disabled={activeView ? !toolbar.canNavigate : !props.onNavigateInPlace}
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
            iconName="pencil-simple"
            variant="plain"
            iconSize={controlMetrics.iconSize}
            accessibilityLabel={t('browserContext.composer.startAnnotation')}
            tooltip={t('browserContext.composer.startAnnotation')}
            selected={annotation.editorActive}
            disabled={markUpDisabledReason !== null && !annotation.editorActive}
            disabledReason={markUpDisabledReason ?? undefined}
            size={controlMetrics.size}
            minimumInteractiveTargetSize={controlMetrics.touchTargetFloorPx ?? undefined}
            interactiveTargetGapPx={4}
            onPress={toggleMarkUp}
        />
    ) : null;
    const attachPageButton = browserContextPresent ? (
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
                minimumInteractiveTargetSize={controlMetrics.touchTargetFloorPx ?? undefined}
                interactiveTargetGapPx={4}
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
    const overflowMenu = (
        <BrowserToolbarOverflowMenu
            testID={`${testID}-overflow`}
            items={overflowItems}
            size={controlMetrics.size}
            iconSize={controlMetrics.iconSize}
            touchTargetFloorPx={controlMetrics.touchTargetFloorPx}
            placement={phone ? 'top' : 'bottom'}
        />
    );
    const navigationControls = (
        <BrowserToolbar
            testID={testID}
            model={toolbar}
            shortcutLabels={browserShortcutLabels}
            controlSize={controlMetrics.size}
            iconSize={controlMetrics.iconSize}
            touchTargetFloorPx={controlMetrics.touchTargetFloorPx}
            spread={phone}
            onBack={() => dispatchViewCommand('goBack')}
            onForward={() => dispatchViewCommand('goForward')}
            onReload={() => dispatchViewCommand('reload')}
            onStop={() => dispatchViewCommand('stop')}
        >
            {phone ? <>{markUpButton}{attachPageButton}{overflowMenu}</> : null}
        </BrowserToolbar>
    );

    return (
        <View testID={testID} style={stylesheet.root} onLayout={chromeDensity.onLayout}>
            {phone ? (showPhoneChrome ? (
                <View testID={`${testID}-top-bar`} style={stylesheet.phoneTopBar}>
                    <View style={stylesheet.phoneAddressSlot}>{addressField}</View>
                    {recordingCapsule}
                    {privacyControl}
                </View>
            ) : null) : (
                <View style={[stylesheet.toolbarRow, { paddingVertical: controlMetrics.rowPaddingVerticalPx }]}>
                    {navigationControls}
                    <View style={stylesheet.addressFieldSlot}>{addressField}</View>
                    {recordingCapsule}
                    {markUpButton}
                    {attachPageButton}
                    {privacyControl}
                    {overflowMenu}
                </View>
            )}
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
                        localServicePreviewServerId={props.localServicePreviewServerId}
                        onOpenTarget={props.onOpenTarget}
                        onNavigateInPlace={props.onNavigateInPlace}
                    />
                ) : (
                    <BrowserViewHost
                        testID={`${testID}-view`}
                        view={activeView}
                        onViewLifecycle={props.onViewLifecycle}
                        lifecycleState={props.lifecycleState}
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
                        agent={props.agent ?? null}
                        nowMs={props.nowMs}
                    />
                )}
                {annotation.editorActive ? (
                    <AnnotationEditorOverlay
                        testID={`${testID}-annotation-editor`}
                        captureCapability={annotation.captureCapability}
                        selectCapability={annotation.selectCapability}
                        markCount={annotation.markCount}
                        marks={annotation.marks}
                        comment={annotation.commentValue}
                        onSelectElement={annotation.selectElement}
                        onAddRegion={annotation.addRegion}
                        onAddStroke={annotation.addStroke}
                        onRemoveMark={annotation.removeMark}
                        onCommentChange={annotation.changeComment}
                        onAttach={annotation.attachDraft}
                        onCancel={annotation.cancel}
                    />
                ) : null}
                {activeView && (isDaemonAuthoritativeBrowserView(activeView)
                    || (props.browserAutomation && props.browserAutomation.enabled !== false)) ? (
                    <BrowserShellPresence
                        testID={`${testID}-presence`}
                        view={activeView}
                        controlService={props.browserAutomation && props.browserAutomation.enabled !== false
                            ? props.browserAutomation.controlService
                            : null}
                        sendDaemonCommand={props.browserContext?.daemonControl?.sendCommand}
                        agent={props.agent ?? null}
                        pageRect={streamedPageRect}
                        compact={chromeDensity.collapsed}
                        nowMs={props.browserAutomation?.nowMs ?? props.nowMs}
                    />
                ) : null}
            </View>
            {activeView && props.onPluginBrowserAction ? (
                <BrowserPluginActionPlacements
                    detailsPanelActions={plugins.detailsPanelActions}
                    contextMenuActions={plugins.contextMenuActions}
                    policyContext={plugins.policyContext}
                    localizePluginText={localizePluginText}
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
            {activeDiagnostics || props.supplementalDiagnostics ? (
                <BrowserDiagnosticsDrawer
                    diagnostics={activeDiagnostics ?? props.supplementalDiagnostics!}
                    state={browserDiagnostics?.eventSource ? undefined : browserDiagnostics?.state}
                    eventSource={browserDiagnostics?.eventSource}
                    supplemental={activeDiagnostics ? props.supplementalDiagnostics : null}
                    interaction={browserDiagnostics?.interaction}
                    surfaceHeightPx={chromeDensity.containerHeightPx ?? undefined}
                    testID={`${testID}-diagnostics`}
                />
            ) : null}
            <BrowserStatusBar
                testID={`${testID}-status`}
                view={activeView}
                onRetry={toolbar.canReload ? () => dispatchViewCommand('reload') : undefined}
            />
            {showPhoneChrome ? (
                <View
                    testID={`${testID}-bottom-bar`}
                    accessibilityRole="toolbar"
                    style={[stylesheet.phoneBottomBar, bottomChromeHeight > 0 ? { paddingBottom: bottomChromeHeight } : null]}
                >
                    {navigationControls}
                </View>
            ) : null}
        </View>
    );
}
