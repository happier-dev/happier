import type {
    SimulatorDeviceResourceV1} from '@happier-dev/protocol/devices/simulator/v1';
import type {
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionV1,
    SimulatorPreviewSnapshotV1,
} from '@happier-dev/protocol/devices/simulator/runtimeV1';

import {
    reduceSimulatorPreviewState,
    type SimulatorPreviewState,
} from './store';

export type SimulatorPreviewDaemonState = Readonly<{
    generatedAt: number | null;
    refreshState: 'idle' | 'refreshing' | 'error';
    resources: readonly SimulatorDeviceResourceV1[] | null;
    previewStatesBySimulatorId: Readonly<Record<string, SimulatorPreviewState | undefined>>;
    diagnostics: readonly unknown[];
}>;

function emptySimulatorState(): SimulatorPreviewState {
    return {
        phase: 'idle',
        lastFrame: null,
    };
}

export function createSimulatorPreviewDaemonState(): SimulatorPreviewDaemonState {
    return {
        generatedAt: null,
        refreshState: 'idle',
        resources: null,
        previewStatesBySimulatorId: {},
        diagnostics: [],
    };
}

export function applySimulatorPreviewDaemonRefreshStarted(
    state: SimulatorPreviewDaemonState,
    generatedAt: number,
): SimulatorPreviewDaemonState {
    // Background retries keep the last failure visible until a snapshot actually recovers.
    if (state.refreshState === 'error') return state;
    return {
        ...state,
        generatedAt,
        refreshState: 'refreshing',
    };
}

export function applySimulatorPreviewDaemonRefreshFailed(
    state: SimulatorPreviewDaemonState,
    generatedAt: number,
): SimulatorPreviewDaemonState {
    if (state.refreshState === 'error') return state;
    return {
        ...state,
        generatedAt,
        refreshState: 'error',
    };
}

export function applySimulatorPreviewDaemonSnapshot(
    state: SimulatorPreviewDaemonState,
    snapshot: SimulatorPreviewSnapshotV1,
): SimulatorPreviewDaemonState {
    let resources: SimulatorPreviewDaemonState['resources'] = snapshot.resources;
    if (snapshot.refreshState === 'error') {
        resources = state.resources;
        if (snapshot.resources.length > 0) {
            const observedResources = new Map((state.resources ?? []).map(resource => [resource.simulatorId, resource]));
            for (const resource of snapshot.resources) observedResources.set(resource.simulatorId, resource);
            resources = [...observedResources.values()];
        }
    }
    return {
        ...state,
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        resources,
        diagnostics: snapshot.diagnostics,
    };
}

export function applySimulatorPreviewDaemonActionResult(
    state: SimulatorPreviewDaemonState,
    event: SimulatorPreviewActionV1,
    result: SimulatorPreviewActionResultV1,
): SimulatorPreviewDaemonState {
    if (result.status !== 'accepted') {
        return state;
    }
    if (event.type === 'simulator.lease.acquire' || event.type === 'simulator.lease.renew') {
        if (!result.lease) {
            return state;
        }
        const previous = state.previewStatesBySimulatorId[event.simulatorId] ?? emptySimulatorState();
        return {
            ...state,
            previewStatesBySimulatorId: {
                ...state.previewStatesBySimulatorId,
                [event.simulatorId]: reduceSimulatorPreviewState(previous, {
                    type: 'lease_acquired',
                    lease: result.lease,
                }),
            },
        };
    }
    if (event.type === 'simulator.lease.release') {
        const previous = state.previewStatesBySimulatorId[event.simulatorId] ?? emptySimulatorState();
        return {
            ...state,
            previewStatesBySimulatorId: {
                ...state.previewStatesBySimulatorId,
                [event.simulatorId]: reduceSimulatorPreviewState(previous, {
                    type: 'lease_released',
                    leaseId: event.leaseId,
                }),
            },
        };
    }
    if (event.type === 'simulator.sideband.request' && result.sideband) {
        const previous = state.previewStatesBySimulatorId[event.simulatorId] ?? emptySimulatorState();
        return {
            ...state,
            previewStatesBySimulatorId: {
                ...state.previewStatesBySimulatorId,
                [event.simulatorId]: reduceSimulatorPreviewState(previous, {
                    type: 'sideband',
                    message: result.sideband,
                }),
            },
        };
    }
    return state;
}
