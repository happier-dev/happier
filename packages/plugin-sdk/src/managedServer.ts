import type { ExecLaunchInputV1 } from './exec.js';

export type ManagedServerStateV1 = 'starting' | 'healthy' | 'unhealthy' | 'stopped';

export type ManagedServerModeV1 = 'managed-spawn' | 'external-attach';

export type ManagedServerHttpCredentialV1 = Readonly<{
    name: string;
    value: string;
}>;

export type ManagedServerCredentialV1 = Readonly<{
    envKey: string;
    value: string;
    httpHeader?: ManagedServerHttpCredentialV1;
}>;

export type ManagedServerLaunchModeV1 = Readonly<
    | {
        kind: 'managed-spawn';
        host?: string;
        port?: number;
        baseUrl?: string;
        portArg?: string;
        portEnvKey?: string;
        baseUrlEnvKey?: string;
        credential?: ManagedServerCredentialV1;
    }
    | {
        kind: 'external-attach';
        baseUrl: string;
        credential?: ManagedServerCredentialV1;
    }
>;

export type ManagedServerHealthCheckV1 = Readonly<
    | {
        kind: 'http';
        url?: string;
        path?: string;
        headers?: Readonly<Record<string, string>>;
        timeoutMs?: number;
    }
    | {
        kind: 'command';
        launch: ExecLaunchInputV1;
        timeoutMs?: number;
    }
>;

export type ManagedServerOrphanReaperV1 = Readonly<{
    executablePath: string;
    commandIncludes?: readonly string[];
    initialSignal?: string;
    forceSignal?: string;
    forceAfterMs?: number;
}>;

export type ManagedServerWatchdogV1 = Readonly<{
    intervalMs: number;
    missedIntervals: number;
}>;

/**
 * Opt-in durable per-server logging for a managed-spawn server. When set, the host tees the
 * supervised process's post-spawn stdout/stderr to a durable, secret-redacted per-server log file
 * (for later incident diagnosis) and prunes old logs by count. Ignored for external-attach servers.
 * Defaults: the host's logs directory; keep the newest 50.
 */
export type ManagedServerDurableLogV1 = Readonly<{
    enabled?: boolean;
    dir?: string;
    keepCount?: number;
}>;

export type ManagedServerSpecV1 = Readonly<{
    id: string;
    launch?: ExecLaunchInputV1;
    mode?: ManagedServerLaunchModeV1;
    healthCheck?: ManagedServerHealthCheckV1;
    orphanReaper?: ManagedServerOrphanReaperV1;
    watchdog?: ManagedServerWatchdogV1;
    durableLog?: ManagedServerDurableLogV1;
    launchFingerprint?: string;
    startupTimeoutMs?: number;
    restart?: 'never';
    signal?: AbortSignal;
}>;

export type ManagedServerDiagnosticsV1 = Readonly<{
    healthCheckUrl?: string;
    exitCode?: number | null;
    exitSignal?: string | null;
    stdoutTail?: string;
    stderrTail?: string;
}>;

export type ManagedServerSnapshotV1 = Readonly<{
    id: string;
    state: ManagedServerStateV1;
    mode?: ManagedServerModeV1;
    baseUrl?: string | null;
    port?: number | null;
    credentialEnvKey?: string | null;
    pid: number | null;
    startedAt: number | null;
    lastHealthyAt: number | null;
    lastErrorMessage: string | null;
    diagnostics?: ManagedServerDiagnosticsV1;
    /** Path to the durable per-server log file, when durable logging is enabled. */
    logPath?: string | null;
}>;

export type ManagedServerHandleV1 = Readonly<{
    snapshot(): ManagedServerSnapshotV1;
    waitUntilHealthy(options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>): Promise<ManagedServerSnapshotV1>;
    pulseLiveness?(event?: Readonly<{ reason?: string }>): void;
    reapOrphans?(options?: Readonly<{ mode?: 'initial' | 'periodic' }>): Promise<void>;
    dispose(): Promise<void>;
}>;

export interface ManagedServerRuntimeServiceV1 {
    supervise(spec: ManagedServerSpecV1): Promise<ManagedServerHandleV1>;
}
