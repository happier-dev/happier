import { createHappierSocket, type HappierSocket } from '@happier-dev/sync-client';
import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1,
} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

import { resolveSocketIoTransportsForCarrier } from '@/sync/runtime/socketIoTransports';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { resolveServerRuntimeOrigin } from '@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin';
import { SERVER_PEER_LIVENESS_WINDOW_MS } from '@/sync/runtime/connectivity/serverReachabilityTuning';

export type ConcurrentServerSocket = HappierSocket;

export function createConcurrentServerSocketTransport(params: Readonly<{
    serverUrl: string;
    token: string;
    carrier?: 'https' | 'iroh';
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
}>): Readonly<{
    socket: ConcurrentServerSocket;
    transport: ManagedConnectionTransport;
}> {
    return createHappierSocket({
        endpoint: resolveServerRuntimeOrigin(params),
        connectTimeoutMs: SERVER_PEER_LIVENESS_WINDOW_MS,
        token: params.token,
        clientType: 'user-scoped',
        clientPurpose: 'concurrent-server-cache',
        authExtras: buildAccountStoredContentCompatibilitySocketAuthV1(
            CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        ),
        transports: resolveSocketIoTransportsForCarrier(params.carrier),
        ...(params.homeCarrier ? { websocketFactory: params.homeCarrier.createWebSocket } : {}),
    });
}
