import * as React from 'react';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneContext';

import { useSimulatorLiveStreamRelaySocket } from '@/components/devices/simulator/relay/useSimulatorLiveStreamRelaySocket';
import { useSimulatorPreviewLiveSurface } from '@/components/devices/simulator/relay/useSimulatorPreviewLiveSurface';

import {
    SimulatorDeviceResourceV1Schema,
    type SimulatorDeviceResourceV1,
} from '@happier-dev/protocol/devices/simulator/v1';

import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { readComputerScreenSessionSurfaceResource } from '@/components/computer/computerScreenDetailsTab';
import { SessionComputerScreenPane } from '@/components/computer/SessionComputerScreenPane';
import { SessionSimulatorPreviewPane } from '@/components/sessions/simulator/SessionSimulatorPreviewPane';
import { selectSimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/selectors';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
type SimulatorPreviewSessionSurfaceResource = Readonly<{
    kind: 'simulatorPreview';
    viewerId?: string;
    selectedSimulatorId?: string | null;
    resources?: unknown;
}>;

const EMPTY_SIMULATOR_PREVIEW_ACTIONS: Partial<SimulatorPreviewActions> = Object.freeze({});

function isSimulatorPreviewSessionSurfaceResource(value: unknown): value is SimulatorPreviewSessionSurfaceResource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'simulatorPreview';
}

function readSimulatorDeviceResources(value: unknown): readonly SimulatorDeviceResourceV1[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((entry) => {
        const parsed = SimulatorDeviceResourceV1Schema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readOptionalNullableString(value: unknown): string | null | undefined {
    return value === null ? null : readOptionalString(value);
}

function resolveSimulatorPreviewViewModel(params: Readonly<{
    resource: SimulatorPreviewSessionSurfaceResource;
    runtime?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>): SimulatorPreviewViewModel {
    const resourceSelectedSimulatorId = readOptionalNullableString(params.resource.selectedSimulatorId);
    if (
        params.runtime?.viewModel
        && (
            !params.runtime.viewModel.resource
            || resourceSelectedSimulatorId === undefined
            || params.runtime.viewModel.selectedSimulatorId === resourceSelectedSimulatorId
        )
    ) {
        return params.runtime.viewModel;
    }
    const resources = params.runtime?.resources
        ?? readSimulatorDeviceResources(params.resource.resources);
    return selectSimulatorPreviewViewModel({
        resources,
        selectedSimulatorId:
            params.runtime?.selectedSimulatorId
            ?? readOptionalNullableString(params.resource.selectedSimulatorId)
            ?? null,
        viewerId:
            params.runtime?.viewerId
            ?? readOptionalString(params.resource.viewerId)
            ?? 'session-simulator-viewer',
        previewStatesBySimulatorId: params.runtime?.previewStatesBySimulatorId,
        playerStatesBySimulatorId: params.runtime?.playerStatesBySimulatorId,
        snapshotDiagnostics: params.runtime?.diagnostics,
        nowMs: params.nowMs?.(),
    });
}

function SessionSimulatorSurface(props: Readonly<{
    sessionId: string;
    scopeId?: string;
    tabKey: string;
    machineId?: string | null;
    serverId?: string | null;
    simulatorViewerId?: string;
    resource: SimulatorPreviewSessionSurfaceResource;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>) {
    const pane = useOptionalAppPaneContext(context => {
        const state = props.scopeId ? context.state.scopes[props.scopeId]?.details.tabState[props.tabKey] : null;
        return {
            dispatch: context.dispatch,
            selectedSimulatorId: state && typeof state === 'object' && 'selectedSimulatorId' in state
                ? readOptionalNullableString(state.selectedSimulatorId) : undefined,
        };
    });
    // Mount below the tab's presentation owner so the runtime observes its own visibility.
    const enabled = props.simulatorPreview === undefined;
    const socket = useSimulatorLiveStreamRelaySocket({
        machineId: props.machineId, serverId: props.serverId, enabled,
    });
    const livePreview = useSimulatorPreviewLiveSurface({
        runtime: {
            machineId: props.machineId, serverId: props.serverId, enabled,
            viewerId: props.simulatorViewerId ?? readOptionalString(props.resource.viewerId) ?? 'session-simulator-viewer',
            selectedSimulatorId: pane?.selectedSimulatorId ?? readOptionalNullableString(props.resource.selectedSimulatorId),
            nowMs: props.nowMs,
        },
        relay: { socket },
    });
    const runtime = props.simulatorPreview !== undefined ? props.simulatorPreview : livePreview;
    const actions = React.useMemo(() => ({
        ...(runtime?.actions ?? EMPTY_SIMULATOR_PREVIEW_ACTIONS),
        selectDevice: (selectedSimulatorId: string) => {
            // The tab outlives the presented runtime; closing it must still release all live work.
            if (props.scopeId && pane?.dispatch) pane.dispatch({
                type: 'patchDetailsTabState', scopeId: props.scopeId, tabKey: props.tabKey,
                patch: { selectedSimulatorId },
            });
            runtime?.actions.selectDevice(selectedSimulatorId);
        },
    }), [runtime?.actions, pane?.dispatch, props.scopeId, props.tabKey]);
    return <SessionSimulatorPreviewPane
        sessionId={props.sessionId}
        viewModel={resolveSimulatorPreviewViewModel({ resource: props.resource, runtime, nowMs: props.nowMs })}
        actions={actions}
    />;
}

export function renderSessionSurfaceTab(params: Readonly<{
    sessionId: string;
    scopeId?: string;
    serverId?: string | null;
    machineId?: string | null;
    simulatorViewerId?: string;
    tab: DetailsTabState;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>): React.ReactNode | null {
    const computerScreen = readComputerScreenSessionSurfaceResource(params.tab.resource);
    if (computerScreen) {
        return <SessionComputerScreenPane sessionId={params.sessionId} serverId={params.serverId ?? null} machineId={computerScreen.machineId} />;
    }
    if (!isSimulatorPreviewSessionSurfaceResource(params.tab.resource)) return null;
    return <SessionSimulatorSurface
        sessionId={params.sessionId}
        scopeId={params.scopeId}
        tabKey={params.tab.key}
        machineId={params.machineId}
        serverId={params.serverId}
        simulatorViewerId={params.simulatorViewerId}
        resource={params.tab.resource}
        simulatorPreview={params.simulatorPreview}
        nowMs={params.nowMs}
    />;
}
