import * as React from 'react';

import { DetailCompanionPane } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { ServiceOccurrenceLogs } from '@/components/machines/services/MachineServiceLogs';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
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
import { t } from '@/text';

import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';
import type { LocalServiceLogOccurrence } from './localServiceOccurrenceActions';
import type { DescribeServiceDeclaration, ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { ServiceRowOpenHandler } from './ServiceRowView';
import { useLocalServiceEntryActions } from './useLocalServiceEntryActions';
import { useLocalServiceLiveFeeds } from './useLocalServiceLiveFeeds';
import { useLocalServicePresentationFeatures } from './useLocalServicePublicPreviewFeature';
import { WorktreePortsLine } from './WorktreePortsLine';
import { useProjectCommandOutputHostScope } from '@/components/inbox/actionOperations/projectCommandOutputHost';
import { DATABASE_CAPTURE_RESOURCE_REF_V1 } from '@happier-dev/database-protocol';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useProjectContext } from '@/components/projects/useProjectContext';
import { useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';
import { readPluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { LocalServiceCaptureView, type LocalServiceCaptureViewId, type LocalServiceCaptureWorktree } from './LocalServiceCaptureView';

type LocalServicesViewId = 'servers' | LocalServiceCaptureViewId;
const CAPTURE_RESOURCE = { pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId, localId: DATABASE_CAPTURE_RESOURCE_REF_V1.contributionId };

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
    // The same observation decides whether this Home offers Local services at all: nothing scans while it does not.
    const { localServicesArm, publicPreviewFeatureEnabled, publicPreviewCapabilityDisabledReasons } = useLocalServicePresentationFeatures(serverId);
    const feeds = useLocalServiceLiveFeeds({
        available: localServicesArm === 'available',
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
    // Show terminal attaches a service's retained output in the bottom terminal of the page that hosts this surface.
    const terminalScopeId = useProjectCommandOutputHostScope();
    const entryActions = useLocalServiceEntryActions({
        machineId,
        serverId,
        sessionId,
        workspaceRoot,
        ...(terminalScopeId ? { terminalScopeId } : {}),
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

    // The checkout's own ports, when its project gives each checkout its own (the ports owner's selected-root result).
    const worktreePorts = launcherState?.worktreePorts ?? null;
    const workspaceRefId = props.workspaceRefId ?? null;
    const portsWorkspace = React.useMemo(() => serverId && machineId && workspaceRefId && workspaceRoot
        ? { serverId, machineId, workspaceId: workspaceRefId, rootPath: workspaceRoot } : null,
    [machineId, serverId, workspaceRefId, workspaceRoot]);
    const scopeNote = worktreePorts ? (
        <WorktreePortsLine
            result={worktreePorts.result}
            workspace={portsWorkspace}
            onReassigned={onRefresh}
            testID={`${props.testID}-worktree-ports`}
        />
    ) : null;

    // The Project and its admitted checkout, read once: the Services panel's plugin surfaces (the Workbench mount's
    // Worktree scope) and this page's capture views are about the same checkout.
    const projectRef = useProjectAccountWorkspaceRef(workspaceRefId, serverId ?? undefined);
    const projectContext = useProjectContext({ serverId: serverId ?? projectRef?.serverId ?? '', projectRef, activeCheckout: projectRef });
    const projectKey = projectContext.target?.projectKey ?? null;
    const checkout = projectContext.target?.checkout ?? null;
    // Capture is offered where this Machine's Telemetry declares its capture Resource for the checkout's Project.
    const captureOffered = readPluginUiResourceProjection(pluginUiProjection?.resourcesById, CAPTURE_RESOURCE) !== null;
    const captureMachineId = checkout?.machineId ?? null;
    const captureWorkspaceId = checkout?.id ?? null;
    const worktree = React.useMemo((): LocalServiceCaptureWorktree | null => captureOffered && projectKey && captureMachineId && captureWorkspaceId
        ? { machineId: captureMachineId, projectId: projectKey, workspaceId: captureWorkspaceId } : null,
    [captureOffered, projectKey, captureMachineId, captureWorkspaceId]);
    const [view, setView] = React.useState<LocalServicesViewId>('servers');
    const shownView: LocalServicesViewId = worktree ? view : 'servers';
    const lifetime = useActiveServerAccountScopeLifetime();
    const presented = useLayoutPresentationActive();
    const viewTabs = worktree ? (
        <SegmentedTabBar<LocalServicesViewId>
            accessibilityLabel={t('deploymentTelemetry.local.views')}
            testIDPrefix={`${props.testID}-view`}
            segmentSizing={props.presentation === 'page' ? 'content' : 'equal'}
            activeTabId={shownView}
            tabs={[{ id: 'servers', label: t('deploymentTelemetry.local.servers') },
                { id: 'endpoints', label: t('deploymentTelemetry.tabs.endpoints') },
                { id: 'traces', label: t('deploymentTelemetry.tabs.traces') },
                { id: 'logs', label: t('deploymentTelemetry.tabs.logs') }]}
            onSelectTab={setView}
        />
    ) : null;
    const showServers = React.useCallback(() => setView('servers'), []);
    const viewBody = worktree && shownView !== 'servers' ? (
        <LocalServiceCaptureView
            lifetime={lifetime && serverId && lifetime.scope.serverId === serverId ? lifetime : null}
            worktree={worktree}
            view={shownView}
            active={presented}
            machineName={machine.sentenceName ?? t('machine.thisMachineInSentence')}
            onShowServers={showServers}
            testID={`${props.testID}-capture`}
        />
    ) : null;

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
            projectId={scope === 'workspace' ? props.workspaceRefId : null}
            projectContext={scope === 'workspace' ? projectContext : undefined}
            testID={`${props.testID}-plugin-stack`}
        />
    );

    return (<>
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
            availability={localServicesArm}
            machine={machine}
            onRefresh={onRefresh}
            presentation={props.presentation}
            onAddService={props.onAddService}
            renderServicePlacement={props.renderServicePlacement}
            describeDeclaration={props.describeDeclaration}
            viewerAccountId={entryActions.viewerAccountId}
            effectReview={entryActions.review}
            scopeNote={scopeNote}
            viewTabs={viewTabs}
            viewBody={viewBody}
            testID={props.testID}
            footer={pluginStack}
        />
        {serverId && entryActions.logOccurrence ? (
            <LocalServiceLogsCompanion
                serverId={serverId}
                occurrence={entryActions.logOccurrence}
                onClose={entryActions.dismissServiceLogs}
                testID={`${props.testID}-logs`}
            />
        ) : null}
    </>);
}

function LocalServiceLogsCompanion({ serverId, occurrence, onClose, testID }: Readonly<{
    serverId: string;
    occurrence: LocalServiceLogOccurrence;
    onClose: () => void;
    testID: string;
}>): React.ReactElement {
    const presented = useLayoutPresentationActive();
    const machine = useMachinePresenceSummary(serverId, presented ? occurrence.machineId : null);
    return (
        <DetailCompanionPane open title={t('machineServices.logs.title')} subtitle={occurrence.name}
            onClose={onClose} testID={testID}>
            <ServiceOccurrenceLogs
                {...occurrence}
                serverId={serverId}
                machineName={machine.sentenceName ?? t('machine.thisMachineInSentence')}
                active={presented}
            />
        </DetailCompanionPane>
    );
}
