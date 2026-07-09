import type { ExecLaunchInputV1 } from './exec.js';

export const HAPPIER_LOCAL_SERVICE_ENV = Object.freeze({
    PORT: 'PORT',
    HOST: 'HOST',
    PRIVATE_URL: 'HAPPIER_URL',
    PREVIEW_URL: 'HAPPIER_PREVIEW_URL',
});

export type LocalServiceConfidenceV1 = 'high' | 'medium' | 'low';

export type LocalServiceOwnerScopedDeclarationV1 = Readonly<{
    id: string;
    launch: ExecLaunchInputV1;
    launchMode:
        | Readonly<{ kind: 'detectAfterLaunch'; minimumConfidence?: LocalServiceConfidenceV1 }>
        | Readonly<{
            kind: 'assignAndInject';
            portPolicy:
                | Readonly<{ kind: 'fixed'; port: number; onCollision?: 'fail' | 'fallback' }>
                | Readonly<{ kind: 'allocated'; preferredPort?: number; onCollision?: 'fail' | 'fallback' }>
                | Readonly<{ kind: 'inherited'; envName: string }>;
            environment?: Readonly<{ inject?: readonly string[] }>;
        }>
        | Readonly<{ kind: 'externalRegistered'; inventoryId: string; minimumConfidence?: LocalServiceConfidenceV1 }>;
    hostPolicy: Readonly<{ kind: 'loopback'; host?: string }>;
    name:
        | Readonly<{ strategy: 'derived'; base: string }>
        | Readonly<{ strategy: 'fixed'; name: string }>;
    healthCheck:
        | Readonly<{ kind: 'none' }>
        | Readonly<{ kind: 'http'; path?: string; timeoutMs?: number }>
        | Readonly<{ kind: 'command'; launch: ExecLaunchInputV1; timeoutMs?: number }>;
    restart: Readonly<{ kind: 'never' }>;
    cleanup: Readonly<{ staleAfterMs: number }>;
}>;

export type LocalServiceDeclarationV1 = LocalServiceOwnerScopedDeclarationV1;

export type LocalServiceRuntimeSnapshotV1 = Readonly<{
    id: string;
    phase: 'starting' | 'detecting' | 'running' | 'unhealthy' | 'stopping' | 'stopped' | 'failed';
    inventoryId?: string;
    port?: number;
    url?: string;
    diagnostics: readonly Readonly<{ code: string; message?: string; severity?: 'info' | 'warning' | 'error' }>[];
}>;

export type LocalServiceHandleV1 = Readonly<{
    snapshot(): LocalServiceRuntimeSnapshotV1;
    stop(): Promise<void>;
}>;

export interface LocalServicesRuntimeServiceV1 {
    declare(declaration: LocalServiceDeclarationV1): Promise<void>;
    start(id: string): Promise<LocalServiceHandleV1>;
    get(id: string): Promise<LocalServiceRuntimeSnapshotV1 | null>;
}

export function defineLocalService<const T extends LocalServiceDeclarationV1>(declaration: T): T {
    return Object.freeze({ ...declaration });
}
