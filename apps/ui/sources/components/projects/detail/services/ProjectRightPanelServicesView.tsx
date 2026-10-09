import * as React from 'react';

import { LocalServicesSurfaceHost } from '@/components/sessions/localServices';
import type { LocalServicesSurfaceHostProps } from '@/components/sessions/localServices/LocalServicesSurfaceHost';
import { createProjectServicePlacementRenderer } from './ProjectServicePlacementControls';
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
    reviewEffect?: LocalServicesSurfaceHostProps['reviewEffect'];
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    /** The Services page leads with its purpose; the rail keeps the pane chrome. Same body. */
    presentation?: 'pane' | 'page';
    testID?: string;
}>;

export function ProjectRightPanelServicesView(props: ProjectRightPanelServicesViewProps = {}): React.ReactElement {
    const renderServicePlacement = React.useMemo(() => createProjectServicePlacementRenderer(
        props.serverId && props.machineId && props.workspaceRefId
            ? { serverId: props.serverId, machineId: props.machineId, refId: props.workspaceRefId } : null,
    ), [props.machineId, props.serverId, props.workspaceRefId]);
    return (
        <LocalServicesSurfaceHost
            machineId={props.machineId}
            serverId={props.serverId}
            workspaceRoot={props.workspaceRoot}
            scope="workspace"
            inventoryState={props.inventoryState}
            launcherState={props.launcherState}
            launcherSnapshotClient={props.launcherSnapshotClient}
            publicPreviewState={props.publicPreviewState}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            runtimeActionExecute={props.runtimeActionExecute}
            reviewEffect={props.reviewEffect}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            presentation={props.presentation}
            renderServicePlacement={renderServicePlacement}
            testID={props.testID ?? 'project-rightpanel-services'}
        />
    );
}
