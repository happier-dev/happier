import type {
    BrowserAutomationActionKindV1,
    BrowserAutomationAdapterCapabilityKindV1,
    BrowserProfileV1,
    BrowserRenderEngineKindV1,
} from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { BrowserFrameUnavailable } from '@/components/browser/frame/BrowserFrameUnavailable';
import { resolveBrowserAdapterUnavailableReason } from '@/sync/domains/browser/adapters/availability';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
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
} from '@/sync/domains/local/services/preview/store';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { ExternalUrlTarget } from './adapters/ExternalUrlTarget';
import { LocalPreviewTarget } from './adapters/LocalPreviewTarget';
import { SimulatorPreviewTarget } from './adapters/SimulatorPreviewTarget';
import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
} from './frame/types';

const stylesheet = StyleSheet.create(() => ({
    root: {
        flex: 1,
        minHeight: 0,
    },
}));

const EMPTY_SIMULATOR_PREVIEW_ACTIONS: Partial<SimulatorPreviewActions> = Object.freeze({});

const INJECTED_PAGE_AUTOMATION_ACTIONS: ReadonlyArray<Readonly<{
    action: BrowserAutomationActionKindV1;
    capability: BrowserAutomationAdapterCapabilityKindV1;
}>> = [
    { action: 'snapshot', capability: 'snapshot' },
    { action: 'semanticSnapshot', capability: 'semanticSnapshot' },
    { action: 'queryElements', capability: 'locatorQuery' },
    { action: 'click', capability: 'click' },
    { action: 'tap', capability: 'tap' },
    { action: 'type', capability: 'type' },
    { action: 'setValue', capability: 'type' },
    { action: 'scroll', capability: 'scroll' },
    { action: 'waitFor', capability: 'waitFor' },
] as const;

type BrowserViewRenderKind =
    | 'localPreview'
    | 'hostedPlugin'
    | 'externalUrl'
    | 'simulatorPreview'
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
            return 'unavailable';
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
    if (input.view.engineKind !== 'webIframe' && input.view.engineKind !== 'nativeWebView') {
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

export function BrowserViewHost(props: Readonly<{
    view: BrowserControlViewState | null;
    /**
     * B-2 cause-2: forwarded from the shell to the active in-app engine so its native page-load
     * callbacks reach the control reducer as lifecycle signals (see `BrowserShell.onViewLifecycle`).
     */
    onViewLifecycle?: (target: BrowserViewLifecycleTarget, signal: BrowserViewLifecycleSignal) => void;
    navigationEffect?: BrowserControlCommandEffect | null;
    localServicePreviewState?: LocalServicePreviewState | null;
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
    const localPreviewUrl = renderKind === 'localPreview'
        ? view.pendingUrl ?? view.currentUrl ?? localPreview?.accessUrl ?? null
        : null;
    if (renderKind === 'localPreview' && view.target.kind === 'localServicePreview' && localPreviewUrl) {
        return (
            <View testID={testID} style={stylesheet.root}>
                <LocalPreviewTarget
                    title={view.title ?? view.target.display?.title ?? localPreview?.resource.display?.title ?? localPreviewUrl}
                    url={localPreviewUrl}
                    testID={`${testID}-frame`}
                    navigationKey={frameNavigationKey}
                    navigationCommand={frameNavigationCommand}
                    diagnostics={diagnosticsBridge}
                    automation={automationBridge}
                    onLifecycle={onViewLifecycle}
                />
            </View>
        );
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
        // Browser navigation URLs are display/navigation state, never proof that
        // hosted-plugin bytes were selected and verified. This specialized route
        // stays unavailable until the Availability owner supplies the exact
        // artifact admission and selected destination binding needed to mount the
        // bound controller without inventing endpoint or method authority.
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
                navigationKey={frameNavigationKey}
                navigationCommand={frameNavigationCommand}
                onLifecycle={onViewLifecycle}
                nowMs={props.nowMs}
                reasonCode={resolveBrowserViewUnavailableReasonCode(view)}
            />
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
