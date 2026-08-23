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
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';
import { useLocalServiceLauncherStartAction } from './launcherStartAction';
import {
    useDetectedLocalServiceForgetAction,
    useDetectedLocalServiceTerminateAction,
    useLocalServiceCopyUrlAction,
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
    /** Exact AppPane-admitted projection when a driver-owned surface supplies it. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionInteractionEnabled?: boolean;
    platform?: LocalServicePreviewPlatform;
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
    const onForgetDetectedService = useDetectedLocalServiceForgetAction({
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const onCopyServiceUrl = useLocalServiceCopyUrlAction({
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
    const hasAdmittedPluginProjection = props.pluginUiProjection !== undefined;
    // AppPane has already admitted the exact projection for a driver-rendered
    // surface. Keep this hook unconditional for React, but disable its
    // ambient target lookup so an explicit unavailable projection cannot
    // subscribe to or replace the driver-owned snapshot.
    const pluginProjection = useScopedPluginUiProjection(hasAdmittedPluginProjection
        ? { machineId: null, serverId: null, enabled: false }
        : { machineId, serverId });
    const pluginUiProjection = hasAdmittedPluginProjection
        ? props.pluginUiProjection ?? null
        : pluginProjection.pluginUiProjection;
    const projectionInteractionEnabled = hasAdmittedPluginProjection
        ? props.projectionInteractionEnabled === true
        : pluginProjection.interactionEnabled;
    const platform = hasAdmittedPluginProjection
        ? props.platform ?? pluginProjection.platform
        : pluginProjection.platform;

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
                onForgetDetectedService={onForgetDetectedService}
                onCopyServiceUrl={onCopyServiceUrl}
                onStartLauncherTarget={onStartLauncherTarget}
                onOpenServiceInBrowser={props.onOpenServiceInBrowser}
                publicPreviewActions={publicPreviewActions}
                onRefresh={props.inventoryState === undefined ? liveInventoryState.refresh : undefined}
                testID={props.testID}
            />
            <PluginSurfacePlacementStack
                container="servicesPanel"
                pluginUiProjection={pluginUiProjection}
                projectionInteractionEnabled={projectionInteractionEnabled}
                machineId={machineId}
                serverId={serverId}
                sessionId={sessionId}
                platform={platform}
                targetKind="services"
                testID={`${props.testID}-plugin-stack`}
            />
        </>
    );
}
