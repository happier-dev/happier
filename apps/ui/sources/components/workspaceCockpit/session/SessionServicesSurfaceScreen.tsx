import * as React from 'react';

import { ProjectCommandOutputHost } from '@/components/inbox/actionOperations/projectCommandOutputHost';

import { LocalServicesSurfaceHost, type LocalServicesSurfaceHostProps } from '@/components/sessions/localServices';
import { useSessionMachineDisplayTarget } from '@/components/sessions/model/useSessionMachineTarget';
import type { FrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type {
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';

export type SessionServicesSurfaceScreenProps = Readonly<{
    sessionId?: string;
    serverId?: string | null;
    outputScopeId?: string | null;
    machineId?: string | null;
    inventoryState?: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: FrontDoorRuntimeActionExecutor;
    onOpenServiceInBrowser?: LocalServicesSurfaceHostProps['onOpenServiceInBrowser'];
}>;

export function SessionServicesSurfaceScreen(props: SessionServicesSurfaceScreenProps = {}): React.ReactElement {
    const sessionId = props.sessionId ?? '';
    const preferredServerId = usePreferredServerIdForSession({ serverId: props.serverId, sessionId });
    const sessionMachineTarget = useSessionMachineDisplayTarget(sessionId, preferredServerId);
    const machineId = props.machineId ?? sessionMachineTarget?.machineId ?? null;

    return (
        <ProjectCommandOutputHost scopeId={props.outputScopeId}>
            <LocalServicesSurfaceHost
                machineId={machineId}
                serverId={preferredServerId}
                sessionId={props.sessionId}
                inventoryState={props.inventoryState}
                launcherState={props.launcherState}
                launcherSnapshotClient={props.launcherSnapshotClient}
                publicPreviewState={props.publicPreviewState}
                publicPreviewStatusClient={props.publicPreviewStatusClient}
                runtimeActionExecute={props.runtimeActionExecute}
                onOpenServiceInBrowser={props.onOpenServiceInBrowser}
                testID="session-mobile-services"
            />
        </ProjectCommandOutputHost>
    );
}
