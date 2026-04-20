import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';

export type SessionAuthSurfaceState = Readonly<{
    message: string;
}>;

export function resolveSessionAuthSurfaceState(params: Readonly<{
    endpointStatus: unknown;
    syncError: {
        message: string;
        kind: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    } | null;
}>): SessionAuthSurfaceState | null {
    if (params.syncError?.kind === 'auth') {
        return { message: params.syncError.message };
    }
    if (params.endpointStatus === 'auth_failed') {
        return { message: createNotAuthenticatedError().message };
    }
    return null;
}
