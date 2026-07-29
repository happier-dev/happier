import * as React from 'react';

import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { PluginSurfacePlacementStack } from '@/components/plugins/surfaces';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import {
    type LocalServiceLauncherSnapshotClient,
    type LocalServiceLauncherState,
    type LocalServiceLaunchTarget,
    useLocalServiceLauncherStateController,
} from '@/sync/domains/local/services/launch';
import {
    type LocalServiceInventorySnapshotClient,
    useLocalServiceInventoryStateController,
} from '@/sync/domains/local/services/inventory/useLocalServiceInventoryState';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { ManagedLocalServicesState } from '@/sync/domains/local/services/managed/store';
import {
    type LocalServiceManagedSnapshotClient,
    useManagedLocalServicesStateController,
} from '@/sync/domains/local/services/managed/useManagedLocalServicesState';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import {
    type LocalServicePublicPreviewStatusClient,
    useLocalServicePublicPreviewStateController,
} from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';
import { useLocalServiceLauncherStartAction } from './launcherStartAction';
import {
    useDetectedLocalServiceTerminateAction,
    useManagedLocalServiceRestartAction,
    useManagedLocalServiceStopAction,
} from './lifecycleActions';
import { useLocalServicePublicPreviewActions } from './publicPreviewActions';
import { useLocalServicePublicPreviewFeatureEnabled } from './useLocalServicePublicPreviewFeature';

export type LocalServicesSurfaceHostProps = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string;
    /** Session-less project scoping by repo root (raw; canonicalized at the daemon boundary). */
    workspaceRoot?: string | null;
    /** Initial scope; defaults to 'workspace'. The toggle mutates local scope state. */
    scope?: 'workspace' | 'machine';
    inventoryState?: LocalServiceInventoryState;
    inventorySnapshotClient?: LocalServiceInventorySnapshotClient;
    managedState?: ManagedLocalServicesState;
    managedSnapshotClient?: LocalServiceManagedSnapshotClient;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: RuntimeActionExecute;
    onOpenServiceInBrowser?: (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
    testID: string;
}>;

export function LocalServicesSurfaceHost(props: LocalServicesSurfaceHostProps): React.ReactElement {
    const machineId = props.machineId ?? null;
    const serverId = props.serverId ?? null;
    const sessionId = props.sessionId;
    const workspaceRoot = props.workspaceRoot ?? null;
    const [scope, setScope] = React.useState<'workspace' | 'machine'>(props.scope ?? 'workspace');
    const publicPreviewFeatureEnabled = useLocalServicePublicPreviewFeatureEnabled(serverId);
    const liveInventoryState = useLocalServiceInventoryStateController({
        machineId,
        serverId,
        sessionId,
        enabled: props.inventoryState === undefined,
        snapshotClient: props.inventorySnapshotClient,
    });
    const liveLauncherState = useLocalServiceLauncherStateController({
        machineId,
        serverId,
        sessionId,
        scope,
        workspaceRoot,
        enabled: props.launcherState === undefined,
        snapshotClient: props.launcherSnapshotClient,
    });
    const livePublicPreviewState = useLocalServicePublicPreviewStateController({
        machineId,
        serverId,
        sessionId,
        enabled: props.publicPreviewState === undefined && publicPreviewFeatureEnabled,
        statusClient: props.publicPreviewStatusClient,
    });
    const liveManagedState = useManagedLocalServicesStateController({
        machineId,
        serverId,
        sessionId,
        enabled: props.managedState === undefined,
        snapshotClient: props.managedSnapshotClient,
    });
    const inventoryState = props.inventoryState ?? liveInventoryState.state;
    const managedState = props.managedState ?? liveManagedState.state;
    const launcherState = props.launcherState !== undefined ? props.launcherState : liveLauncherState.state;
    // Single front door (FINALIZATION-PLAN §3.1/§12.6): local-service runtime actions dispatch
    // through ActionExecutor.execute via the canonical bridge, so ActionsSettings enablement and
    // approval routing apply — never the raw runtime executor.
    const runtimeActionExecute = React.useMemo(
        () => props.runtimeActionExecute ?? createFrontDoorRuntimeActionExecutor(),
        [props.runtimeActionExecute],
    );
    const onStopManagedService = useManagedLocalServiceStopAction({
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const onRestartManagedService = useManagedLocalServiceRestartAction({
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const onTerminateDetectedService = useDetectedLocalServiceTerminateAction({
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const onStartLauncherTarget = useLocalServiceLauncherStartAction({
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
        applyLauncherSnapshot: props.launcherState === undefined ? liveLauncherState.applySnapshot : undefined,
    });
    const publicPreviewState = props.publicPreviewState !== undefined
        ? props.publicPreviewState
        : livePublicPreviewState.state;
    const publicPreviewActions = useLocalServicePublicPreviewActions({
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const pluginProjection = useScopedPluginUiProjection({
        machineId,
        serverId,
    });

    return (
        <>
            <DetectedLocalServicesPane
                inventoryState={inventoryState}
                managedState={managedState}
                launcherState={launcherState}
                publicPreviewState={publicPreviewState}
                sessionId={sessionId}
                scope={scope}
                onChangeScope={setScope}
                onStopManagedService={onStopManagedService}
                onRestartManagedService={onRestartManagedService}
                onTerminateDetectedService={onTerminateDetectedService}
                onStartLauncherTarget={onStartLauncherTarget}
                onOpenServiceInBrowser={props.onOpenServiceInBrowser}
                publicPreviewActions={publicPreviewActions}
                testID={props.testID}
            />
            <PluginSurfacePlacementStack
                placement="services.panel"
                pluginUiProjection={pluginProjection.pluginUiProjection}
                projectionInteractionEnabled={pluginProjection.interactionEnabled}
                machineId={machineId ?? pluginProjection.machineId}
                serverId={serverId ?? pluginProjection.serverId}
                platform={pluginProjection.platform}
                targetKind="services"
                testID={`${props.testID}-plugin-stack`}
            />
        </>
    );
}
