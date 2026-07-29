import * as React from 'react';

import { LocalServicesSurfaceHost } from '@/components/sessions/localServices';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import type {
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherState,
    LocalServiceLaunchTarget,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { ManagedLocalServicesState } from '@/sync/domains/local/services/managed/store';
import type { LocalServiceManagedSnapshotClient } from '@/sync/domains/local/services/managed/useManagedLocalServicesState';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';

export type SessionServicesSurfaceScreenProps = Readonly<{
    sessionId?: string;
    serverId?: string | null;
    machineId?: string | null;
    inventoryState?: LocalServiceInventoryState;
    managedState?: ManagedLocalServicesState;
    managedSnapshotClient?: LocalServiceManagedSnapshotClient;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: RuntimeActionExecute;
    onOpenServiceInBrowser?: (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
}>;

export function SessionServicesSurfaceScreen(props: SessionServicesSurfaceScreenProps = {}): React.ReactElement {
    const sessionId = props.sessionId ?? '';
    const sessionMachineTarget = useSessionMachineTarget(sessionId);
    const preferredServerId = usePreferredServerIdForSession(sessionId, props.serverId);
    const machineId = props.machineId ?? sessionMachineTarget?.machineId ?? null;

    return (
        <LocalServicesSurfaceHost
            machineId={machineId}
            serverId={preferredServerId}
            sessionId={props.sessionId}
            inventoryState={props.inventoryState}
            managedState={props.managedState}
            managedSnapshotClient={props.managedSnapshotClient}
            launcherState={props.launcherState}
            launcherSnapshotClient={props.launcherSnapshotClient}
            publicPreviewState={props.publicPreviewState}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            runtimeActionExecute={props.runtimeActionExecute}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            testID="session-mobile-services"
        />
    );
}
