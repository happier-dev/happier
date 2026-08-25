import * as React from 'react';

import { LocalServicesSurfaceHost } from '@/components/sessions/localServices';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import type {
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherState,
    LocalServiceLaunchTarget,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';

export type ProjectRightPanelServicesViewProps = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    workspaceRoot?: string | null;
    inventoryState?: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: RuntimeActionExecute;
    onOpenServiceInBrowser?: (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
}>;

export function ProjectRightPanelServicesView(props: ProjectRightPanelServicesViewProps = {}): React.ReactElement {
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
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            testID="project-rightpanel-services"
        />
    );
}
