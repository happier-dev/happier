import type { ExecLaunchInputV1 } from './exec';

export type ManagedServerStateV1 = 'starting' | 'healthy' | 'unhealthy' | 'stopped';

export type ManagedServerHealthCheckV1 = Readonly<
    | {
        kind: 'http';
        url: string;
        timeoutMs?: number;
    }
    | {
        kind: 'command';
        launch: ExecLaunchInputV1;
        timeoutMs?: number;
    }
>;

export type ManagedServerSpecV1 = Readonly<{
    id: string;
    launch: ExecLaunchInputV1;
    healthCheck?: ManagedServerHealthCheckV1;
    startupTimeoutMs?: number;
    restart?: 'never';
    signal?: AbortSignal;
}>;

export type ManagedServerSnapshotV1 = Readonly<{
    id: string;
    state: ManagedServerStateV1;
    pid: number | null;
    startedAt: number | null;
    lastHealthyAt: number | null;
    lastErrorMessage: string | null;
}>;

export type ManagedServerHandleV1 = Readonly<{
    snapshot(): ManagedServerSnapshotV1;
    waitUntilHealthy(options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>): Promise<ManagedServerSnapshotV1>;
    dispose(): Promise<void>;
}>;

export interface ManagedServerRuntimeServiceV1 {
    supervise(spec: ManagedServerSpecV1): Promise<ManagedServerHandleV1>;
}
