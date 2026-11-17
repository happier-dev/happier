import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import type {
    DeviceSimulatorPreviewCapabilities} from '@happier-dev/protocol/features/payload/capabilities/deviceCapabilities';
import type {
    FeaturesResponse as ServerFeatures} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type {
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol/devices/simulator/v1';
import {
    DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
} from '@happier-dev/protocol/features/payload/capabilities/deviceCapabilities';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import {
    createSimulatorPreviewApi,
    type SimulatorPreviewApi,
    type SimulatorPreviewApiEvent,
    type SimulatorPreviewApiDispatch,
    type SimulatorDeviceOperationActionExecute,
} from './api';
import type { SimulatorDeviceOperationResultV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';
import type { SimulatorPreviewState } from './store';
import type {
    SimulatorPreviewStreamState,
    SimulatorPreviewViewModel,
} from './types';
import {
    applySimulatorPreviewDaemonActionResult,
    applySimulatorPreviewDaemonRefreshFailed,
    applySimulatorPreviewDaemonRefreshStarted,
    applySimulatorPreviewDaemonSnapshot,
    createSimulatorPreviewDaemonState,
} from './runtimeState';
import {
    dispatchSimulatorPreviewActionViaMachineRpc,
    fetchSimulatorPreviewSnapshotViaMachineRpc,
    type SimulatorPreviewActionClientInput,
    type SimulatorPreviewActionClientResult,
    type SimulatorPreviewSnapshotClientInput,
    type SimulatorPreviewSnapshotClientResult,
} from './machineRpc';
import { useSimulatorPreview, type SimulatorPreviewActions } from './useSimulatorPreview';

export type SimulatorPreviewSurfaceRuntime = Readonly<{
    viewModel?: SimulatorPreviewViewModel | null;
    actions?: Partial<SimulatorPreviewActions> | null;
    resources?: readonly SimulatorDeviceResourceV1[];
    diagnostics?: readonly unknown[];
    selectedSimulatorId?: string | null;
    viewerId?: string;
    previewStatesBySimulatorId?: Readonly<Record<string, SimulatorPreviewState | undefined>>;
    playerStatesBySimulatorId?: Readonly<Record<string, SimulatorPreviewStreamState | undefined>>;
}>;

export type UseSimulatorPreviewSessionSurfaceRuntimeInput = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    viewerId: string;
    selectedSimulatorId?: string | null;
    selectedDeviceId?: string | null;
    resources?: readonly SimulatorDeviceResourceV1[] | null;
    previewStatesBySimulatorId?: Readonly<Record<string, SimulatorPreviewState | undefined>>;
    playerStatesBySimulatorId?: Readonly<Record<string, SimulatorPreviewStreamState | undefined>>;
    api?: Partial<SimulatorPreviewApi>;
    dispatch?: SimulatorPreviewApiDispatch | null;
    /**
     * Clock as a *function* (L0-3), not a render-time value. Passing a freshly-resolved number
     * each render churns the `nowMsRef` effect and the view-model memo, which (with live relay
     * ingestion) re-triggers the relay open-effect — the "Maximum update depth" loop. Threading
     * the function and resolving `Date.now()` inside effects/memos keeps the render output stable.
     */
    nowMs?: () => number;
    refreshIntervalMs?: number | null;
    snapshotClient?: (input: SimulatorPreviewSnapshotClientInput) => Promise<SimulatorPreviewSnapshotClientResult>;
    actionClient?: (input: SimulatorPreviewActionClientInput) => Promise<SimulatorPreviewActionClientResult>;
}>;

const DEFAULT_REFRESH_INTERVAL_MS = 15_000;
const EMPTY_RESOURCES: readonly SimulatorDeviceResourceV1[] = Object.freeze([]);

function selectSimulatorPreviewCapabilities(features: ServerFeatures): DeviceSimulatorPreviewCapabilities {
    return features.capabilities.devices.simulatorPreview;
}

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

function resolveRefreshIntervalMs(value: number | null | undefined): number | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'number') {
        return DEFAULT_REFRESH_INTERVAL_MS;
    }
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.max(1_000, Math.floor(value));
}

function resolveNowMsFn(value: (() => number) | undefined): () => number {
    return value ?? Date.now;
}

function actionResultUpdatesDaemonState(event: SimulatorPreviewApiEvent): boolean {
    return event.type === 'simulator.lease.acquire'
        || event.type === 'simulator.lease.renew'
        || event.type === 'simulator.lease.release'
        || event.type === 'simulator.sideband.request';
}

function resolveRuntimeResources(input: Readonly<{
    explicitResources?: readonly SimulatorDeviceResourceV1[] | null;
    capabilities: DeviceSimulatorPreviewCapabilities;
    featureEnabled: boolean;
    daemonRuntimeAvailable: boolean;
}>): readonly SimulatorDeviceResourceV1[] {
    if (!input.featureEnabled) {
        return EMPTY_RESOURCES;
    }
    if (input.explicitResources) {
        return input.explicitResources;
    }
    // A selected Machine's daemon owns its inventory; server capability devices can belong elsewhere.
    if (input.daemonRuntimeAvailable || !input.capabilities.enabled || !input.capabilities.available) {
        return EMPTY_RESOURCES;
    }
    return input.capabilities.availableDevices;
}

function resolveSelectedSimulatorId(input: Readonly<{
    resources: readonly SimulatorDeviceResourceV1[];
    selectedSimulatorId?: string | null;
    selectedDeviceId?: string | null;
}>): string | null {
    const selectedSimulatorId = String(input.selectedSimulatorId ?? '').trim();
    if (selectedSimulatorId.length > 0) {
        return selectedSimulatorId;
    }
    const selectedDeviceId = String(input.selectedDeviceId ?? '').trim();
    if (selectedDeviceId.length === 0) {
        return null;
    }
    return input.resources.find((resource) => (
        resource.deviceId === selectedDeviceId || resource.simulatorId === selectedDeviceId
    ))?.simulatorId ?? null;
}

export function useSimulatorPreviewSessionSurfaceRuntime(
    input: UseSimulatorPreviewSessionSurfaceRuntimeInput,
): SimulatorPreviewSurfaceRuntime {
    const presented = useLayoutPresentationActive();
    const hostViewed = useHostActivelyViewed();
    const active = presented && hostViewed;
    const machineId = normalizeId(input.machineId);
    const serverId = normalizeId(input.serverId);
    const refreshIntervalMs = resolveRefreshIntervalMs(input.refreshIntervalMs);
    const snapshotClient = input.snapshotClient ?? fetchSimulatorPreviewSnapshotViaMachineRpc;
    const actionClient = input.actionClient ?? dispatchSimulatorPreviewActionViaMachineRpc;
    const featureScope = React.useMemo(() => (
        serverId
            ? { scopeKind: 'spawn' as const, serverId }
            : { scopeKind: 'runtime' as const }
    ), [serverId]);
    const featureDecision = useFeatureDecision('devices.simulatorPreview', featureScope);
    const capabilities = useFeatureDetails({
        featureId: 'devices.simulatorPreview',
        fallback: DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
        select: selectSimulatorPreviewCapabilities,
        scope: featureScope,
    });
    const [daemonState, setDaemonState] = React.useState(createSimulatorPreviewDaemonState);
    const snapshotClientRef = React.useRef(snapshotClient);
    const actionClientRef = React.useRef(actionClient);
    const nowMs = resolveNowMsFn(input.nowMs);
    const nowMsRef = React.useRef(nowMs);
    const featureEnabled = featureDecision?.state === 'enabled';
    // The feature decision admits discovery; device availability comes from the selected daemon.
    const daemonRuntimeAvailable = (input.enabled ?? true) && Boolean(machineId) && featureEnabled;
    const daemonRuntimeEnabled = daemonRuntimeAvailable && active;
    const actionScope = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        if (!daemonRuntimeEnabled) return;
        const controller = new AbortController();
        actionScope.current = controller;
        return () => {
            controller.abort();
            if (actionScope.current === controller) actionScope.current = null;
        };
    }, [daemonRuntimeEnabled, machineId, serverId]);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        actionClientRef.current = actionClient;
        nowMsRef.current = nowMs;
    }, [actionClient, nowMs, snapshotClient]);

    React.useEffect(() => {
        if (!active && daemonRuntimeAvailable) return;
        if (!daemonRuntimeEnabled || !machineId) {
            setDaemonState(createSimulatorPreviewDaemonState());
            return;
        }

        let disposed = false;
        let inFlight = false;
        const abortController = typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;

        const refresh = async () => {
            if (inFlight || disposed) {
                return;
            }
            inFlight = true;
            setDaemonState((previous) => applySimulatorPreviewDaemonRefreshStarted(
                previous,
                nowMsRef.current(),
            ));
            const result = await snapshotClientRef.current({
                machineId,
                serverId,
                signal: abortController?.signal,
            });
            inFlight = false;
            if (disposed) {
                return;
            }
            setDaemonState((previous) => (
                result.ok
                    ? applySimulatorPreviewDaemonSnapshot(previous, result.snapshot)
                    : applySimulatorPreviewDaemonRefreshFailed(previous, nowMsRef.current())
            ));
        };

        void refresh();
        const intervalId = refreshIntervalMs
            ? setInterval(() => {
                void refresh();
            }, refreshIntervalMs)
            : null;

        return () => {
            disposed = true;
            abortController?.abort();
            if (intervalId) {
                clearInterval(intervalId);
            }
        };
    }, [active, daemonRuntimeAvailable, daemonRuntimeEnabled, machineId, refreshIntervalMs, serverId]);

    const resources = React.useMemo(() => resolveRuntimeResources({
        explicitResources: input.resources ?? daemonState.resources,
        capabilities,
        featureEnabled,
        daemonRuntimeAvailable,
    }), [capabilities, daemonRuntimeAvailable, daemonState.resources, featureEnabled, input.resources]);

    const executeDeviceOperationAction = React.useMemo<SimulatorDeviceOperationActionExecute>(() => {
        const execute = createFrontDoorUiActionExecutor(undefined, serverId ? { serverId } : undefined);
        return async (actionId, operation) => {
            const result = await execute(actionId, operation, {
                ...(machineId ? { externalActionTarget: { kind: 'machine', machineId } as const } : {}),
                signal: actionScope.current?.signal,
                ...(operation.operation === 'screenshot' ? { defaultSessionId: operation.sessionId } : {}),
            });
            // The Action front door validates the declared result before returning it.
            return result as SimulatorDeviceOperationResultV1;
        };
    }, [machineId, serverId]);

    const apiFromDispatch = React.useMemo(() => {
        if (!input.dispatch) {
            return null;
        }
        return createSimulatorPreviewApi({ dispatch: input.dispatch, executeDeviceOperationAction });
    }, [executeDeviceOperationAction, input.dispatch]);

    const apiFromDaemon = React.useMemo(() => {
        if (!daemonRuntimeEnabled || !machineId) {
            return null;
        }
        return createSimulatorPreviewApi({
            executeDeviceOperationAction,
            dispatch: async (event) => {
                const signal = actionScope.current?.signal;
                if (!signal || signal.aborted) return;
                const result = await actionClientRef.current({
                    machineId,
                    serverId,
                    event,
                    signal,
                });
                if (!signal.aborted && result.ok && actionResultUpdatesDaemonState(event)) {
                    setDaemonState((previous) => applySimulatorPreviewDaemonActionResult(
                        previous,
                        event,
                        result.result,
                    ));
                }
            },
        });
    }, [daemonRuntimeEnabled, executeDeviceOperationAction, machineId, serverId]);

    const selectedSimulatorId = resolveSelectedSimulatorId({
        resources,
        selectedSimulatorId: input.selectedSimulatorId,
        selectedDeviceId: input.selectedDeviceId,
    });

    const preview = useSimulatorPreview({
        resources,
        snapshotState: daemonRuntimeAvailable && input.resources == null ? daemonState : undefined,
        selectedSimulatorId,
        viewerId: input.viewerId,
        previewStatesBySimulatorId: input.previewStatesBySimulatorId ?? daemonState.previewStatesBySimulatorId,
        playerStatesBySimulatorId: input.playerStatesBySimulatorId,
        snapshotDiagnostics: daemonState.diagnostics,
        nowMs: input.nowMs,
        api: featureEnabled ? input.api ?? apiFromDispatch ?? apiFromDaemon ?? undefined : undefined,
    });

    return React.useMemo(() => ({
        viewModel: preview.viewModel,
        actions: preview.actions,
        resources,
        diagnostics: daemonState.diagnostics,
        selectedSimulatorId: preview.viewModel.selectedSimulatorId,
        viewerId: preview.viewModel.viewerId,
        previewStatesBySimulatorId: input.previewStatesBySimulatorId ?? daemonState.previewStatesBySimulatorId,
        playerStatesBySimulatorId: input.playerStatesBySimulatorId,
    }), [
        daemonState.diagnostics,
        daemonState.previewStatesBySimulatorId,
        input.playerStatesBySimulatorId,
        input.previewStatesBySimulatorId,
        preview.actions,
        preview.viewModel,
        resources,
    ]);
}
