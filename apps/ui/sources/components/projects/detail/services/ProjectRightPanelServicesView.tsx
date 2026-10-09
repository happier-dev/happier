import * as React from 'react';

import { LocalServicesSurfaceHost } from '@/components/sessions/localServices';
import { createProjectServicePlacementRenderer } from './ProjectServicePlacementControls';
import { useProjectDefinitionInspection } from '@/components/projects/projectSetup/useProjectDefinitionInspection';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ServiceRowOpenHandler } from '@/components/sessions/localServices/ServiceRowView';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import type {
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';

export type ProjectRightPanelServicesViewProps = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    /** The SOURCE checkout's accepted ref: service placement is saved there, never on a worker copy. */
    workspaceRefId?: string | null;
    workspaceRoot?: string | null;
    inventoryState?: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: RuntimeActionExecute;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    /** The Services page leads with its purpose; the rail keeps the pane chrome. Same body. */
    presentation?: 'pane' | 'page';
    testID?: string;
}>;

export function ProjectRightPanelServicesView(props: ProjectRightPanelServicesViewProps = {}): React.ReactElement {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId ?? '');
    const workspace = React.useMemo<WorkspaceAddressV1 | null>(() => props.serverId && props.machineId && props.workspaceRefId && props.workspaceRoot
        ? { serverId: props.serverId, machineId: props.machineId, workspaceId: props.workspaceRefId, rootPath: props.workspaceRoot } : null,
    [props.machineId, props.serverId, props.workspaceRefId, props.workspaceRoot]);
    const inspection = useProjectDefinitionInspection(workspace, binding);
    const declarations = React.useMemo(() => {
        const document = inspection.read && 'value' in inspection.read ? inspection.read.value.definition.document : null;
        return document?.status === 'valid' ? Object.fromEntries(Object.entries(document.manifest.services ?? {}).map(([name, service]) =>
            [name, { portable: service.execution === 'portable', ...(service.memoryDemand ? { memoryDemand: service.memoryDemand } : {}) }])) : {};
    }, [inspection.read]);
    const renderServicePlacement = React.useMemo(() => createProjectServicePlacementRenderer(
        props.serverId && props.machineId && props.workspaceRefId
            ? { serverId: props.serverId, machineId: props.machineId, refId: props.workspaceRefId } : null,
        declarations,
    ), [declarations, props.machineId, props.serverId, props.workspaceRefId]);
    return (
        <LocalServicesSurfaceHost
            machineId={props.machineId}
            serverId={props.serverId}
            workspaceRoot={props.workspaceRoot}
            workspaceRefId={props.workspaceRefId}
            scope="workspace"
            inventoryState={props.inventoryState}
            launcherState={props.launcherState}
            launcherSnapshotClient={props.launcherSnapshotClient}
            publicPreviewState={props.publicPreviewState}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            runtimeActionExecute={props.runtimeActionExecute}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            presentation={props.presentation}
            renderServicePlacement={renderServicePlacement}
            testID={props.testID ?? 'project-rightpanel-services'}
        />
    );
}
