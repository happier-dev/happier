import type { ScopedSocketClient, ScopedSocketConnectParams } from './serverScopedRpcTypes';
import { serverScopedRpcSocketPool } from './serverScopedRpcSocketPool';
import { apiSocket } from '@/sync/api/session/apiSocket';

export async function createEphemeralServerSocketClient(params: ScopedSocketConnectParams): Promise<ScopedSocketClient> {
    // One user-scoped socket per Account and Home: a scoped caller for the Home and bearer the
    // connection owner already serves rides that socket. A Session consumer keeps its own entry.
    const lent = params.sessionId === undefined && !params.signal?.aborted ? apiSocket.lendScopedSocketClient(params) : null;
    if (!lent) return await serverScopedRpcSocketPool.acquire(params);
    // The pool never took this eagerly handed-over carrier, so it is released here (as the pool
    // releases a redundant one); `takeCarrierRelease` stays with its caller.
    await params.releaseCarrier?.().catch((error: unknown) => {
        console.error('[scoped-rpc] redundant carrier release failed', error);
    });
    return lent;
}
