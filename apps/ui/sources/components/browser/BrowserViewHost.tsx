import type {
    BrowserProfileV1,
    BrowserRenderEngineKindV1,
} from '@happier-dev/protocol';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { BrowserFrameUnavailable } from '@/components/browser/frame/BrowserFrameUnavailable';
import { BrowserFrameLoading } from '@/components/browser/frame/BrowserFrameLoading';
import { BrowserLocalPreviewElsewhere, BrowserLocalPreviewPublicLinkControls } from '@/components/browser/frame/BrowserLocalPreviewElsewhere';
import { resolveBrowserAdapterUnavailableReason } from '@/sync/domains/browser/adapters/availability';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
import { INJECTED_PAGE_AUTOMATION_ACTIONS } from '@happier-dev/peer-mediation/browser/collector/actions';
import { resolveHostedPluginBrowserPolicyUnavailableReason } from '@/sync/domains/browser/policy/evaluate';
import type {
    BrowserControlCommandEffect,
    BrowserControlViewState,
    BrowserViewLifecycleEmitter,
    BrowserViewLifecycleSignal,
    BrowserViewLifecycleTarget,
} from '@/sync/domains/browser/control';
import { selectSimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/selectors';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import {
    selectLocalServicePreviewByBrowserTarget,
    type LocalServicePreviewState,
    type LocalServicePreviewRow,
} from '@/sync/domains/local/services/preview/store';
import { useNativeDirectPreview } from '@/sync/domains/local/services/preview/useNativeDirectPreview';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { BrowserStreamedTarget, type BrowserStreamedPageRect, type BrowserStreamedSurfaceRuntime } from './adapters/BrowserStreamedTarget';
import { ExternalUrlTarget } from './adapters/ExternalUrlTarget';
import { useBrowserSessionAgentIdentity, type BrowserShellAgentPresence } from './copresence/BrowserShellPresence';
import { LocalPreviewTarget } from './adapters/LocalPreviewTarget';
import { SimulatorPreviewTarget } from './adapters/SimulatorPreviewTarget';
import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from './frame/types';
import type { BrowserSurfaceLifecycleState } from './surfaces/browserSurfaceLifecycle';

const stylesheet = StyleSheet.create(() => ({
    root: {
        flex: 1,
        minHeight: 0,
    },
}));

const EMPTY_SIMULATOR_PREVIEW_ACTIONS: Partial<SimulatorPreviewActions> = Object.freeze({});

type BrowserViewRenderKind =
    | 'localPreview'
    | 'hostedPlugin'
    | 'externalUrl'
    | 'simulatorPreview'
    | 'streamedBrowser'
    | 'unavailable';

type BrowserClientLocalNavigationEffect = Extract<BrowserControlCommandEffect, { kind: 'clientLocalNavigation' }>;

function resolveBrowserViewRenderKind(view: BrowserControlViewState): BrowserViewRenderKind {
    switch (view.adapterKind) {
        case 'localPreview':
            return view.target.kind === 'localServicePreview' ? 'localPreview' : 'unavailable';
        case 'hostedPlugin':
            return view.target.kind === 'hostedPluginWeb' ? 'hostedPlugin' : 'unavailable';
        case 'externalUrl':
            return view.target.kind === 'externalUrl' ? 'externalUrl' : 'unavailable';
        case 'simulatorPreview':
            return view.target.kind === 'simulatorPreview' ? 'simulatorPreview' : 'unavailable';
        case 'chromiumSidecar':
        case 'streamedBrowserSurface':
            // A browser that runs on a machine (the agent's managed Chromium): shown as its live
            // stream, never as an embedded page.
            return 'streamedBrowser';
    }
}

function resolveBrowserViewUnavailableReasonCode(view: BrowserControlViewState): string {
    return resolveBrowserAdapterUnavailableReason({
        adapterKind: view.adapterKind,
        targetKind: view.target.kind,
    }).reasonCode;
}

function resolveViewDiagnosticsBridge(input: Readonly<{
    view: BrowserControlViewState;
    bridge?: BrowserDiagnosticsEngineBridgeConfig | null;
}>): BrowserDiagnosticsEngineBridgeConfig | undefined {
    const bridge = input.bridge;
    if (!bridge) {
        return undefined;
    }
    if (
        bridge.browserSessionId !== input.view.browserSessionId
        || bridge.viewId !== input.view.viewId
        || bridge.navigationGeneration !== input.view.navigationGeneration
    ) {
        return undefined;
    }
    return bridge;
}

function isAutomationActionAvailable(value: unknown): boolean {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as Readonly<Record<string, unknown>>).available === true,
    );
}

function resolveInjectedPageSupportedActions(view: BrowserControlViewState): readonly string[] {
    const actions = view.adapterCapabilities.automationActions;
    if (!actions) return [];
    return INJECTED_PAGE_AUTOMATION_ACTIONS
        .filter((entry) => isAutomationActionAvailable(actions[entry.capability]))
        .map((entry) => entry.action);
}

function resolveViewAutomationBridge(input: Readonly<{
    view: BrowserControlViewState;
    bridge?: BrowserDiagnosticsEngineBridgeConfig | null;
    automation?: Readonly<{
        controlService: BrowserAutomationControlService;
        enabled?: boolean;
        supportedActions?: readonly string[];
        nowMs?: () => number;
        onRegistrationRejected?: (reasonCode: string) => void;
        onRejectedMessage?: (reasonCode: string) => void;
    }> | null;
}>): BrowserAutomationEngineBridgeConfig | undefined {
    const automation = input.automation;
    if (!automation || automation.enabled === false) {
        return undefined;
    }
    if (input.view.engineKind !== 'webIframe' && input.view.engineKind !== 'nativeWebView'
        && input.view.engineKind !== 'desktopWebView') {
        return undefined;
    }
    const bridge = resolveViewDiagnosticsBridge({
        view: input.view,
        bridge: input.bridge,
    });
    if (!bridge) {
        return undefined;
    }
    const supportedActions = automation.supportedActions ?? resolveInjectedPageSupportedActions(input.view);
    if (supportedActions.length === 0) {
        return undefined;
    }
    return {
        browserSessionId: input.view.browserSessionId,
        viewId: input.view.viewId,
        navigationGeneration: input.view.navigationGeneration,
        collectorId: bridge.collectorId,
        nonce: bridge.nonce,
        capabilityVersion: bridge.collectorVersion,
        adapterKind: input.view.adapterKind,
        sourceOrigin: bridge.sourceOrigin,
        supportedActions,
        controlService: automation.controlService,
        nowMs: automation.nowMs,
        onRegistrationRejected: automation.onRegistrationRejected,
        onRejectedMessage: automation.onRejectedMessage,
    };
}

function resolveSimulatorPreviewViewModel(input: Readonly<{
    view: BrowserControlViewState;
    runtime?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>): SimulatorPreviewViewModel {
    const targetDeviceId = input.view.target.kind === 'simulatorPreview'
        ? input.view.target.deviceId
        : null;
    const targetSourceId = input.view.target.kind === 'simulatorPreview'
        ? input.view.target.sourceId
        : null;
    const selectedSimulatorId = input.runtime?.resources?.find((resource) => (
        (targetSourceId && resource.capture.sourceId === targetSourceId)
        || resource.simulatorId === targetDeviceId
        || resource.deviceId === targetDeviceId
    ))?.simulatorId ?? input.runtime?.selectedSimulatorId ?? null;
    if (
        input.runtime?.viewModel
        && (!selectedSimulatorId || input.runtime.viewModel.selectedSimulatorId === selectedSimulatorId)
    ) {
        return input.runtime.viewModel;
    }
    return selectSimulatorPreviewViewModel({
        resources: input.runtime?.resources ?? [],
        selectedSimulatorId,
        viewerId: input.runtime?.viewerId ?? input.view.viewId,
        previewStatesBySimulatorId: input.runtime?.previewStatesBySimulatorId,
        playerStatesBySimulatorId: input.runtime?.playerStatesBySimulatorId,
        snapshotDiagnostics: input.runtime?.diagnostics,
        nowMs: input.nowMs?.(),
    });
}

function resolveClientLocalNavigationEffect(input: Readonly<{
    view: BrowserControlViewState;
    navigationEffect?: BrowserControlCommandEffect | null;
}>): BrowserClientLocalNavigationEffect | null {
    const effect = input.navigationEffect;
    if (!effect || effect.kind !== 'clientLocalNavigation' || effect.viewId !== input.view.viewId) {
        return null;
    }
    if (effect.command.browserSessionId !== input.view.browserSessionId) {
        return null;
    }
    return effect;
}

/**
 * `reload` is fulfilled differently per engine, and this is the one place that decides which.
 *
 * The sandboxed `webIframe` engine reloads by REMOUNTING on a fresh `navigationKey`: a cross-origin
 * frame rejects `contentWindow.location.reload()`, so the key is the only reliable route. Every
 * command-driven engine (the RN `WebView`, the Wry desktop child view) reloads through its own
 * navigation command and has no `navigationKey` at all — routing their reload to the key was why
 * the toolbar Reload button dispatched nothing on iOS, Android and desktop.
 */
function resolveFrameNavigationKey(
    effect: BrowserClientLocalNavigationEffect | null,
    engineKind: BrowserRenderEngineKindV1,
): string | undefined {
    if (!effect || effect.command.kind !== 'reload' || engineKind !== 'webIframe') {
        return undefined;
    }
    return effect.command.commandId;
}

function resolveFrameNavigationCommand(
    effect: BrowserClientLocalNavigationEffect | null,
    engineKind: BrowserRenderEngineKindV1,
) {
    if (!effect || effect.command.kind === 'navigate') {
        return undefined;
    }
    if (effect.command.kind === 'reload' && engineKind === 'webIframe') {
        // Already fulfilled by the remount key above; dispatching it as well would fire
        // `location.reload()` at the freshly mounted frame.
        return undefined;
    }
    return {
        commandId: effect.command.commandId,
        kind: effect.command.kind,
    } as const;
}

/** The agent's streamed browser, named for its agent (the identity leaf reads the session). */
function StreamedBrowserView(props: Readonly<{
    runtime: BrowserStreamedSurfaceRuntime | null;
    agent: BrowserShellAgentPresence | null;
    onPageRectChange?: (rect: BrowserStreamedPageRect | null) => void;
    onOpenPageHere?: () => void;
    onClosePage?: () => void;
    testID: string;
}>): React.ReactElement {
    const identity = useBrowserSessionAgentIdentity(props.agent);
    return <BrowserStreamedTarget runtime={props.runtime} agentName={identity.name} onPageRectChange={props.onPageRectChange}
        onOpenPageHere={props.onOpenPageHere} onClosePage={props.onClosePage} testID={props.testID} />;
}

function buildViewLifecycleEmitter(input: Readonly<{
    view: BrowserControlViewState;
    onViewLifecycle?: (target: BrowserViewLifecycleTarget, signal: BrowserViewLifecycleSignal) => void;
}>): BrowserViewLifecycleEmitter | undefined {
    const onViewLifecycle = input.onViewLifecycle;
    if (!onViewLifecycle) {
        return undefined;
    }
    const target: BrowserViewLifecycleTarget = {
        browserSessionId: input.view.browserSessionId,
        viewId: input.view.viewId,
    };
    return (signal) => onViewLifecycle(target, signal);
}

/** Target access stays mounted while its snapshot and navigation projection change. */
function LocalPreviewView(props: Readonly<{
    view: BrowserControlViewState;
    target: Extract<BrowserControlViewState['target'], { kind: 'localServicePreview' }>;
    preview: LocalServicePreviewRow | null;
    serverId?: string | null;
    profileId?: string | null;
    lifecycleState?: BrowserSurfaceLifecycleState;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    onLifecycle?: BrowserViewLifecycleEmitter;
    testID: string;
}>): React.ReactElement {
    const { view, preview, target, testID } = props;
    const noServerRoute = preview?.accessUnavailableReasonCode === 'preview_private_route_unavailable';
    const lifecycleAllowsLease = props.lifecycleState !== 'suspended'
        && props.lifecycleState !== 'closed' && props.lifecycleState !== 'orphaned';
    const nativeDirectEnabled = Boolean(preview?.nativeDirect
        && preview.nativeDirect.previewId === preview.previewId
        && preview.nativeDirect.machineId === preview.resource.machineId);
    const access = useNativeDirectPreview({
        // These are routing identities. The selected Home resolves the actual current registration.
        previewId: preview?.previewId ?? target.targetId,
        machineId: preview?.resource.machineId ?? target.machineId,
        serverId: props.serverId,
        enabled: lifecycleAllowsLease && (view.engineKind === 'webIframe' || view.engineKind === 'nativeWebView' || view.engineKind === 'desktopWebView'),
        nativeDirectEnabled,
        fallbackUrl: noServerRoute ? null : preview?.accessUrl ?? null,
        requestedUrl: noServerRoute && !preview?.nativeDirect ? null : view.pendingUrl ?? view.currentUrl,
        initialPath: preview ? preview.resource.initialPath.pathname + preview.resource.initialPath.search : undefined,
    });
    const title = view.title ?? target.display?.title ?? preview?.resource.display?.title
        ?? target.display?.addressLabel ?? target.targetId;
    const nativeOrigin = access.localOrigin && access.url?.startsWith(`${access.localOrigin}/`) ? access.localOrigin : null;
    const diagnostics = React.useMemo(() => nativeOrigin && props.diagnostics
        ? { ...props.diagnostics, sourceOrigin: nativeOrigin } : props.diagnostics, [nativeOrigin, props.diagnostics]);
    const automation = React.useMemo(() => nativeOrigin && props.automation
        ? { ...props.automation, sourceOrigin: nativeOrigin } : props.automation, [nativeOrigin, props.automation]);
    return <View testID={testID} style={stylesheet.root}>
        {access.acquiring ? <BrowserFrameLoading testID={testID} host={title} /> : access.url ? <LocalPreviewTarget
            title={title}
            url={access.url}
            view={view}
            profileId={props.profileId}
            lifecycleState={props.lifecycleState}
            testID={`${testID}-frame`}
            navigationKey={props.navigationKey}
            navigationCommand={props.navigationCommand}
            diagnostics={diagnostics}
            automation={automation}
            onLifecycle={props.onLifecycle}
        /> : noServerRoute ? <BrowserLocalPreviewElsewhere testID={testID} serviceTitle={title} machineId={target.machineId} />
                : <BrowserFrameUnavailable testID={testID} reasonCode={resolveBrowserViewUnavailableReasonCode(view)} />}
        <BrowserLocalPreviewPublicLinkControls target={target} serviceTitle={title} serverId={props.serverId} testID={`${testID}-public-link`} />
    </View>;
}

export function BrowserViewHost(props: Readonly<{
    view: BrowserControlViewState | null;
    /**
     * B-2 cause-2: forwarded from the shell to the active in-app engine so its native page-load
     * callbacks reach the control reducer as lifecycle signals (see `BrowserShell.onViewLifecycle`).
     */
    onViewLifecycle?: (target: BrowserViewLifecycleTarget, signal: BrowserViewLifecycleSignal) => void;
    lifecycleState?: BrowserSurfaceLifecycleState;
    navigationEffect?: BrowserControlCommandEffect | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionInteractionEnabled?: boolean;
    simulatorPreviewRuntime?: SimulatorPreviewSurfaceRuntime | null;
    diagnosticsBridge?: BrowserDiagnosticsEngineBridgeConfig | null;
    browserAutomation?: Readonly<{
        controlService: BrowserAutomationControlService;
        enabled?: boolean;
        supportedActions?: readonly string[];
        nowMs?: () => number;
        onRegistrationRejected?: (reasonCode: string) => void;
        onRejectedMessage?: (reasonCode: string) => void;
    }> | null;
    browserProfile?: BrowserProfileV1 | null;
    /** The live stream of a browser that runs on a machine, for `chromiumSidecar`/streamed views. */
    streamedBrowserRuntime?: BrowserStreamedSurfaceRuntime | null;
    /** The session whose agent drives the page, to name it in the streamed states. */
    agent?: BrowserShellAgentPresence | null;
    /** Where a streamed view's page is drawn inside this host, for the agent cursor. */
    onStreamedPageRectChange?: (rect: BrowserStreamedPageRect | null) => void;
    onOpenStreamedPageHere?: () => void;
    onClosePage?: () => void;
    nowMs?: () => number;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-view-host';
    const view = props.view;
    if (!view) {
        return <BrowserFrameUnavailable testID={testID} />;
    }
    const renderKind = resolveBrowserViewRenderKind(view);
    const onViewLifecycle = buildViewLifecycleEmitter({ view, onViewLifecycle: props.onViewLifecycle });
    const navigationEffect = resolveClientLocalNavigationEffect({
        view,
        navigationEffect: props.navigationEffect,
    });
    const frameNavigationKey = resolveFrameNavigationKey(navigationEffect, view.engineKind);
    const frameNavigationCommand = resolveFrameNavigationCommand(navigationEffect, view.engineKind);
    const diagnosticsBridge = resolveViewDiagnosticsBridge({
        view,
        bridge: props.diagnosticsBridge,
    });
    const automationBridge = resolveViewAutomationBridge({
        view,
        bridge: diagnosticsBridge,
        automation: props.browserAutomation,
    });
    const localPreview = renderKind === 'localPreview' && view.target.kind === 'localServicePreview' && props.localServicePreviewState
        ? selectLocalServicePreviewByBrowserTarget(props.localServicePreviewState, view.target)
        : null;
    if (renderKind === 'localPreview' && view.target.kind === 'localServicePreview') {
        return <LocalPreviewView
            key={browserViewKey(view)}
            view={view}
            target={view.target}
            preview={localPreview}
            serverId={props.localServicePreviewServerId}
            profileId={props.browserProfile?.profileId}
            lifecycleState={props.lifecycleState}
            testID={testID}
            navigationKey={frameNavigationKey}
            navigationCommand={frameNavigationCommand}
            diagnostics={diagnosticsBridge}
            automation={automationBridge}
            onLifecycle={onViewLifecycle}
        />;
    }
    if (renderKind === 'hostedPlugin' && view.target.kind === 'hostedPluginWeb') {
        const policyUnavailableReason = resolveHostedPluginBrowserPolicyUnavailableReason({
            target: view.target,
            profile: props.browserProfile,
        });
        if (policyUnavailableReason) {
            return (
                <BrowserFrameUnavailable
                    testID={testID}
                    reasonCode={policyUnavailableReason}
                />
            );
        }
        // This target carries no selected destination binding or current surface
        // scope. Plugin browser contributions currently produce externalUrl targets.
        // Navigation URLs cannot substitute for the exact artifact admission and
        // mount context owned by PluginSurfaceHost.
        return (
            <BrowserFrameUnavailable
                testID={testID}
                reasonCode="hosted_plugin_artifact_unavailable"
            />
        );
    }
    if (renderKind === 'externalUrl') {
        return (
            <ExternalUrlTarget
                testID={`${testID}-frame`}
                view={view}
                profileId={props.browserProfile?.profileId ?? null}
                diagnostics={diagnosticsBridge}
                automation={automationBridge}
                navigationKey={frameNavigationKey}
                navigationCommand={frameNavigationCommand}
                onLifecycle={onViewLifecycle}
                lifecycleState={props.lifecycleState}
                nowMs={props.nowMs}
                reasonCode={resolveBrowserViewUnavailableReasonCode(view)}
            />
        );
    }
    if (renderKind === 'streamedBrowser') {
        return (
            <View testID={testID} style={stylesheet.root}>
                <StreamedBrowserView
                    runtime={props.streamedBrowserRuntime ?? null}
                    agent={props.agent ?? null}
                    onPageRectChange={props.onStreamedPageRectChange}
                    onOpenPageHere={props.onOpenStreamedPageHere}
                    onClosePage={props.onClosePage}
                    testID={`${testID}-streamed`}
                />
            </View>
        );
    }
    if (renderKind === 'simulatorPreview') {
        return (
            <View testID={testID} style={stylesheet.root}>
                <SimulatorPreviewTarget
                    viewModel={resolveSimulatorPreviewViewModel({
                        view,
                        runtime: props.simulatorPreviewRuntime,
                        nowMs: props.nowMs,
                    })}
                    actions={props.simulatorPreviewRuntime?.actions ?? EMPTY_SIMULATOR_PREVIEW_ACTIONS}
                    testID={`${testID}-simulator`}
                />
            </View>
        );
    }
    return (
        <BrowserFrameUnavailable
            testID={testID}
            reasonCode={resolveBrowserViewUnavailableReasonCode(view)}
        />
    );
}
