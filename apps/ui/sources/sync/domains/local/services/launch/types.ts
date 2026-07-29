import type {
    DaemonLocalServiceLauncherHistoryClearResponseV1,
    DaemonLocalServiceLauncherOpenPreviewResponseV1,
    DaemonLocalServiceLauncherRegisterPreviewResponseV1,
    DaemonLocalServiceLauncherStartResponseV1,
    LocalServiceLauncherSnapshotV1,
    LocalServiceLaunchTargetV1,
} from '@happier-dev/protocol';

export type LocalServiceLaunchTarget = LocalServiceLaunchTargetV1;
export type LocalServiceLauncherSnapshot = LocalServiceLauncherSnapshotV1;

export type LocalServiceLauncherRefreshStatus = 'idle' | 'refreshing' | 'error';

export type LocalServiceLauncherRouteFailureReason = 'unavailable' | 'request_failed' | 'invalid_response';

export type LocalServiceLauncherStartClientInput = Readonly<{
    machineId: string;
    targetId: string;
    serverId?: string | null;
    sessionId?: string | null;
    workspaceId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServiceLauncherStartClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServiceLauncherStartResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServiceLauncherRouteFailureReason }>;

// LSV-1 launcher leaves (UI → daemon machine-RPC). `openPreview`/`registerPreview` are bound to
// a launch target; `history.clear` is target-less. They mirror the launcher.start client shape.
export type LocalServiceLauncherLeafTargetClientInput = Readonly<{
    machineId: string;
    targetId: string;
    serverId?: string | null;
    sessionId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServiceLauncherHistoryClearClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServiceLauncherOpenPreviewClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServiceLauncherOpenPreviewResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServiceLauncherRouteFailureReason }>;

export type LocalServiceLauncherRegisterPreviewClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServiceLauncherRegisterPreviewResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServiceLauncherRouteFailureReason }>;

export type LocalServiceLauncherHistoryClearClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServiceLauncherHistoryClearResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServiceLauncherRouteFailureReason }>;

export type LocalServiceLauncherState = Readonly<{
    machineId: string | null;
    sessionId: string | null;
    updatedAt: number | null;
    refreshStatus: LocalServiceLauncherRefreshStatus;
    refreshError: string | null;
    targetIds: readonly string[];
    targetsById: ReadonlyMap<string, LocalServiceLaunchTarget>;
}>;
