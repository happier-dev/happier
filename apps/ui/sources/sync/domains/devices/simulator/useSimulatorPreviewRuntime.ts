import * as React from 'react';
import type {
    DeviceSimulatorPreviewCapabilities,
    FeaturesResponse as ServerFeatures,
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';
import {
    DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
} from '@happier-dev/protocol';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';

import {
    createSimulatorPreviewApi,
    type SimulatorPreviewApi,
    type SimulatorPreviewApiEvent,
    type SimulatorPreviewApiDispatch,
} from './api';
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
}>): readonly SimulatorDeviceResourceV1[] {
    if (!input.featureEnabled) {
        return [];
    }
    if (input.explicitResources) {
        return input.explicitResources;
    }
    if (!input.capabilities.enabled || !input.capabilities.available) {
        return [];
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
    const enabled = input.enabled ?? true;
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
    const daemonRuntimeEnabled = enabled && Boolean(machineId) && featureEnabled && capabilities.enabled;

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        actionClientRef.current = actionClient;
        nowMsRef.current = nowMs;
    }, [actionClient, nowMs, snapshotClient]);

    React.useEffect(() => {
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
    }, [daemonRuntimeEnabled, machineId, refreshIntervalMs, serverId]);

    const resources = React.useMemo(() => resolveRuntimeResources({
        explicitResources: input.resources ?? daemonState.resources,
        capabilities,
        featureEnabled,
    }), [capabilities, daemonState.resources, featureEnabled, input.resources]);

    const apiFromDispatch = React.useMemo(() => {
        if (!input.dispatch) {
            return null;
        }
        return createSimulatorPreviewApi({ dispatch: input.dispatch });
    }, [input.dispatch]);

    const apiFromDaemon = React.useMemo(() => {
        if (!daemonRuntimeEnabled || !machineId) {
            return null;
        }
        return createSimulatorPreviewApi({
            dispatch: async (event) => {
                const result = await actionClientRef.current({
                    machineId,
                    serverId,
                    event,
                });
                if (result.ok && actionResultUpdatesDaemonState(event)) {
                    setDaemonState((previous) => applySimulatorPreviewDaemonActionResult(
                        previous,
                        event,
                        result.result,
                    ));
                }
            },
        });
    }, [daemonRuntimeEnabled, machineId, serverId]);

    const selectedSimulatorId = resolveSelectedSimulatorId({
        resources,
        selectedSimulatorId: input.selectedSimulatorId,
        selectedDeviceId: input.selectedDeviceId,
    });

    const preview = useSimulatorPreview({
        resources,
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
