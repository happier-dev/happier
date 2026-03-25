import type { ScopedSocketClient, ScopedSocketConnectParams } from './serverScopedRpcTypes';
import { serverScopedRpcSocketPool } from './serverScopedRpcSocketPool';

export async function createEphemeralServerSocketClient(params: ScopedSocketConnectParams): Promise<ScopedSocketClient> {
    return await serverScopedRpcSocketPool.acquire(params);
}
