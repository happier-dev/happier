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
} from './lifecycleActions';
import { useLocalServicePublicPreviewActions } from './publicPreviewActions';
import {
    useLocalServiceCapabilityDisabledReasons,
    useLocalServicePublicPreviewFeatureEnabled,
} from './useLocalServicePublicPreviewFeature';

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
    // Resolved once for the whole surface: the server names which prerequisite is unmet, and the
    // rows render it instead of one generic sentence for eleven different causes (audit P1-3).
    const publicPreviewCapabilityDisabledReasons = useLocalServiceCapabilityDisabledReasons(serverId);
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
    // The pane's rows are built from the daemon's LAUNCHER feed, and inventory entries only enrich
    // them — so making the inventory fresh is not enough on its own for a service started after
    // mount to appear. The launcher feed is derived from the same inventory the daemon just
    // rescanned, so it needs no push producer of its own: one push source (the inventory watch)
    // drives the derived read. `generatedAt` advancing is exactly "the daemon rescanned".
    const inventoryGeneratedAt = liveInventoryState.state.generatedAt;
    const refreshLauncher = liveLauncherState.refresh;
    const lastSyncedInventoryGeneratedAtRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (props.inventoryState !== undefined || inventoryGeneratedAt === null) {
            return;
        }
        if (lastSyncedInventoryGeneratedAtRef.current === inventoryGeneratedAt) {
            return;
        }
        const isFirstObservation = lastSyncedInventoryGeneratedAtRef.current === null;
        lastSyncedInventoryGeneratedAtRef.current = inventoryGeneratedAt;
        // The launcher's own mount read already covers the first snapshot; only a later change
        // needs a derived re-read.
        if (!isFirstObservation) {
            refreshLauncher?.();
        }
    }, [inventoryGeneratedAt, props.inventoryState, refreshLauncher]);

    // An explicit refresh re-reads both halves directly rather than relying on the derived chain:
    // an unchanged inventory would otherwise leave the launcher feed untouched, and a user who
    // pressed refresh is entitled to a real re-read of what they can see.
    const refreshInventory = liveInventoryState.refresh;
    const onRefresh = React.useMemo(() => {
        if (props.inventoryState !== undefined || !refreshInventory) {
            return undefined;
        }
        return () => {
            refreshInventory();
            refreshLauncher?.();
        };
    }, [props.inventoryState, refreshInventory, refreshLauncher]);

    const inventoryState = props.inventoryState ?? liveInventoryState.state;
    const launcherState = props.launcherState !== undefined ? props.launcherState : liveLauncherState.state;
    // Single front door (FINALIZATION-PLAN §3.1/§12.6): local-service runtime actions dispatch
    // through ActionExecutor.execute via the canonical bridge, so ActionsSettings enablement and
    // approval routing apply — never the raw runtime executor.
    const runtimeActionExecute = React.useMemo(
        () => props.runtimeActionExecute ?? createFrontDoorRuntimeActionExecutor(),
        [props.runtimeActionExecute],
    );
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
                launcherState={launcherState}
                publicPreviewState={publicPreviewState}
                sessionId={sessionId}
                scope={scope}
                onChangeScope={setScope}
                onTerminateDetectedService={onTerminateDetectedService}
                onForgetDetectedService={onForgetDetectedService}
                onCopyServiceUrl={onCopyServiceUrl}
                onStartLauncherTarget={onStartLauncherTarget}
                onOpenServiceInBrowser={props.onOpenServiceInBrowser}
                publicPreviewActions={publicPreviewActions}
                publicPreviewCapabilityDisabledReasons={publicPreviewCapabilityDisabledReasons}
                onRefresh={onRefresh}
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
