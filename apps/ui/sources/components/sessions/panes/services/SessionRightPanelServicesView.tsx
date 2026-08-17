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
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';

export type SessionRightPanelServicesViewProps = Readonly<{
    sessionId?: string;
    serverId?: string | null;
    machineId?: string | null;
    /** AppPane-admitted plugin facts; omission retains standalone Session lookup. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionInteractionEnabled?: boolean;
    platform?: LocalServicePreviewPlatform;
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

export function SessionRightPanelServicesView(props: SessionRightPanelServicesViewProps = {}): React.ReactElement {
    const sessionId = props.sessionId ?? '';
    const sessionMachineTarget = useSessionMachineTarget(sessionId);
    const preferredServerId = usePreferredServerIdForSession(sessionId);
    // Keep the fallback hooks alive for standalone direct routes. A supplied
    // pane target, including explicit null, is already AppPane-authoritative.
    const machineId = props.machineId !== undefined
        ? props.machineId
        : sessionMachineTarget?.machineId ?? null;
    const serverId = props.serverId !== undefined
        ? props.serverId
        : preferredServerId;
    const hasAdmittedPluginProjection = props.pluginUiProjection !== undefined;

    return (
        <LocalServicesSurfaceHost
            machineId={machineId}
            serverId={serverId}
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
            {...(hasAdmittedPluginProjection ? {
                pluginUiProjection: props.pluginUiProjection ?? null,
                projectionInteractionEnabled: props.projectionInteractionEnabled === true,
                platform: props.platform,
            } : {})}
            testID="session-rightpanel-services"
        />
    );
}
