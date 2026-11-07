import * as React from 'react';

import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import { PluginSurfacePlacementStack } from '@/components/plugins/surfaces';
import type { FrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type {
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventorySnapshotClient } from '@/sync/domains/local/services/inventory/useLocalServiceInventoryState';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';
import type { DescribeServiceDeclaration, ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { ServiceRowOpenHandler } from './ServiceRowView';
import { useLocalServiceEntryActions } from './useLocalServiceEntryActions';
import { useLocalServiceLiveFeeds } from './useLocalServiceLiveFeeds';
import { useLocalServicePresentationFeatures } from './useLocalServicePublicPreviewFeature';

export type LocalServicesSurfaceHostProps = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string;
    /** Session-less project scoping by repo root (raw; canonicalized at the daemon boundary). */
    workspaceRoot?: string | null;
    workspaceRefId?: string | null;
    /** Initial scope; defaults to 'workspace'. The toggle mutates local scope state. */
    scope?: 'workspace' | 'machine';
    inventoryState?: LocalServiceInventoryState;
    inventorySnapshotClient?: LocalServiceInventorySnapshotClient;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: FrontDoorRuntimeActionExecutor;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    /** Exact AppPane-admitted projection when a driver-owned surface supplies it. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionInteractionEnabled?: boolean;
    platform?: LocalServicePreviewPlatform;
    /** `page` on the Project Services page; the rail and Session panel keep the pane chrome. */
    presentation?: 'pane' | 'page';
    /** Leads the empty state to where a service is declared (Project Scripts page). */
    onAddService?: () => void;
    /** The placement owner's per-row "Runs on" control (plan 32), hosted in each row's expansion. */
    renderServicePlacement?: (row: ServiceRow) => React.ReactNode;
    /** The Project definition's command and source file for a declared service. */
    describeDeclaration?: DescribeServiceDeclaration;
    testID: string;
}>;

export function LocalServicesSurfaceHost(props: LocalServicesSurfaceHostProps): React.ReactElement {
    const machineId = props.machineId ?? null;
    const serverId = props.serverId ?? null;
    const sessionId = props.sessionId;
    const sessionWorkspace = useSessionWorkspaceTarget(sessionId, serverId);
    const workspaceRoot = props.workspaceRoot ?? sessionWorkspace?.rootPath ?? null;
    const [scope, setScope] = React.useState<'workspace' | 'machine'>(props.scope ?? 'workspace');
    // The header line and the offline state name the machine and read its presence: one summary,
    // primitives only, so presence heartbeats that change nothing re-render nothing.
    const machine = useMachinePresenceSummary(serverId, machineId);
    // Resolved once for the whole surface: the server names which prerequisite is unmet, and the
    // rows render it instead of one generic sentence for eleven different causes (audit P1-3).
    const { publicPreviewFeatureEnabled, publicPreviewCapabilityDisabledReasons } = useLocalServicePresentationFeatures(serverId);
    const feeds = useLocalServiceLiveFeeds({
        machineId,
        serverId,
        sessionId,
        workspaceRoot,
        workspaceRefId: props.workspaceRefId,
        scope,
        inventoryState: props.inventoryState,
        launcherState: props.launcherState,
        inventorySnapshotClient: props.inventorySnapshotClient,
        launcherSnapshotClient: props.launcherSnapshotClient,
    });
    const { inventoryState, launcherState, refresh: onRefresh } = feeds;
    const entryActions = useLocalServiceEntryActions({
        machineId,
        serverId,
        sessionId,
        workspaceRoot,
        scope,
        runtimeActionExecute: props.runtimeActionExecute,
        onRefresh,
        applyLauncherSnapshot: feeds.applyLauncherSnapshot,
        testID: props.testID,
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

    const pluginStack = (
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
    );

    return (
        <DetectedLocalServicesPane
            inventoryState={inventoryState}
            launcherState={launcherState}
            publicPreviewState={props.publicPreviewState}
            sourceMachineId={machineId}
            serverId={serverId}
            publicPreviewEnabled={publicPreviewFeatureEnabled}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            sessionId={sessionId}
            scope={scope}
            onChangeScope={setScope}
            {...entryActions.handlers}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            publicPreviewCapabilityDisabledReasons={publicPreviewCapabilityDisabledReasons}
            machine={machine}
            onRefresh={onRefresh}
            presentation={props.presentation}
            onAddService={props.onAddService}
            renderServicePlacement={props.renderServicePlacement}
            describeDeclaration={props.describeDeclaration}
            viewerAccountId={entryActions.viewerAccountId}
            effectReview={entryActions.review}
            testID={props.testID}
            footer={pluginStack}
        />
    );
}
