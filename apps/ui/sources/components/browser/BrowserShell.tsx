import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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
import { BROWSER_CHROME_WIDTH, useBrowserChromeDensity } from './browserChromeDensity';
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
import { getPreferredLanguage } from '@/text';

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
        // The row no longer WRAPS. Wrapping was the old answer to nine clusters in a 380px pane, and
        // it bought a usable address field with a toolbar that silently doubled in height. There are
        // four clusters now — navigation, address, identity, overflow — and the collapsed density
        // drops the identity chip to its glyph, so the row fits without a second line.
        flexWrap: 'nowrap',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderBottomWidth: 1,
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
    },
    // Live-status controls (recording / automation) sit on their own line UNDER the chrome rather
    // than inside it. They appear only while something is actually running, so a row that exists
    // only in that moment can afford the height, and the toolbar above it never reflows.
    liveStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        rowGap: 6,
        gap: 8,
        paddingHorizontal: 10,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    viewHost: {
        flex: 1,
        minHeight: 0,
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
    // Measured CONTAINER width, not the window: the same shell renders into a ~380px session panel
    // and a 2560px window on one machine, and only the container knows which.
    const chromeDensity = useBrowserChromeDensity();
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

    const overflowItems = useBrowserToolbarOverflowItems({
        activeView,
        annotation,
        browserContextPresent: Boolean(props.browserContext),
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools: openDesktopDevtools,
        plugins,
        pluginActionsEnabled: Boolean(props.onPluginBrowserAction),
        localizePluginText,
    });

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

    return (
        <View testID={testID} style={stylesheet.root} onLayout={chromeDensity.onLayout}>
            <View style={stylesheet.toolbarRow}>
                <BrowserToolbar
                    testID={testID}
                    model={toolbar}
                    shortcutLabels={browserShortcutLabels}
                    onBack={() => dispatchViewCommand('goBack')}
                    onForward={() => dispatchViewCommand('goForward')}
                    onReload={() => dispatchViewCommand('reload')}
                    onStop={() => dispatchViewCommand('stop')}
                />
                <View style={stylesheet.addressFieldSlot}>
                    <BrowserUrlField
                        testID={`${testID}-address`}
                        focusRef={urlFieldRef}
                        density="toolbar"
                        trailingAction="copy"
                        formatWhileBlurred
                        value={activeView?.pendingUrl ?? activeView?.currentUrl ?? ''}
                        disabled={activeView ? !toolbar.canNavigate : !props.onNavigateInPlace}
                        {...(props.searchUrlTemplate ? { searchUrlTemplate: props.searchUrlTemplate } : {})}
                        onSubmitUrl={dispatchNavigate}
                    />
                </View>
                {/*
                  * One identity chip, not three. The page title lives on the workspace tab strip that
                  * already owns it, and the origin-kind pill folded into this chip's fallback label.
                  * Collapsed, it keeps its glyph and drops its label: trust is never the thing that
                  * gets hidden to save width.
                  */}
                <SecurityOriginIndicator
                    testID={`${testID}-security`}
                    view={activeView}
                    compact={chromeDensity.collapsed}
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
            </View>
            {props.browserRecording || props.browserAutomation ? (
                <View style={stylesheet.liveStatusRow}>
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
            ) : null}
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
                    supplemental={activeDiagnostics ? props.supplementalDiagnostics : null}
                    interaction={browserDiagnostics?.interaction}
                    surfaceHeightPx={chromeDensity.containerHeightPx ?? undefined}
                    testID={`${testID}-diagnostics`}
                />
            ) : null}
            <BrowserStatusBar
                testID={`${testID}-status`}
                view={activeView}
            />
        </View>
    );
}
