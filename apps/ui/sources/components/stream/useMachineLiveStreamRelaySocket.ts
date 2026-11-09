import * as React from 'react';

import {
    resolveServerScopedMachineLiveStreamRelaySocket,
    type ServerScopedMachineLiveStreamRelaySocket,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/**
 * The production `server_relay` viewer socket for one source machine, whatever the stream shows
 * (a simulator, the agent's browser). Opened only while `enabled` and a machine id is known, and
 * disconnected on teardown or when the machine changes. A surface's own policy (a feature decision)
 * decides `enabled`; this owner only owns the socket's lifetime.
 */
export function useMachineLiveStreamRelaySocket(input: Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    enabled?: boolean;
    disconnectTag: string;
    /** A local carrier may supply the same socket lifecycle without opening a network connection. */
    resolveSocket?: typeof resolveServerScopedMachineLiveStreamRelaySocket;
}>): ServerScopedMachineLiveStreamRelaySocket | null {
    const enabled = input.enabled ?? true;
    const machineId = String(input.machineId ?? '').trim();
    const serverId = String(input.serverId ?? '').trim();
    const tag = input.disconnectTag;
    const accountLifetime = input.accountLifetime;
    const resolveSocket = input.resolveSocket ?? resolveServerScopedMachineLiveStreamRelaySocket;
    const [socket, setSocket] = React.useState<ServerScopedMachineLiveStreamRelaySocket | null>(null);
    const previousDisconnect = React.useRef<Readonly<{
        accountLifetime: typeof accountLifetime;
        completion: Promise<void>;
    }> | null>(null);

    React.useEffect(() => {
        if (!enabled || !machineId) {
            setSocket(null);
            return;
        }
        let disposed = false;
        let resolved: ServerScopedMachineLiveStreamRelaySocket | null = null;
        const disconnect = (client: ServerScopedMachineLiveStreamRelaySocket) => {
            const completion = client.disconnect();
            previousDisconnect.current = { accountLifetime, completion };
            fireAndForget(completion, { tag });
        };
        // Hide/show retains this subscriber's identity; its earlier admission must finish Stop
        // before it opens again. Remounted subscribers have their own stream identity instead.
        const closing = previousDisconnect.current;
        const acquire = async () => {
            if (closing && closing.accountLifetime === accountLifetime) await closing.completion;
            if (disposed) return null;
            return await resolveSocket({ machineId, serverId: serverId || null, accountLifetime });
        };
        void acquire()
            .then((next) => {
                if (!next) return;
                if (disposed) {
                    disconnect(next);
                    return;
                }
                resolved = next;
                setSocket(next);
            })
            .catch(() => {
                if (!disposed) setSocket(null);
            });
        return () => {
            disposed = true;
            if (resolved) disconnect(resolved);
            setSocket(null);
        };
    }, [accountLifetime, enabled, machineId, resolveSocket, serverId, tag]);

    const subscribe = React.useCallback((listener: () => void) => socket ? socket.onSocketIdChange(listener) : () => {}, [socket]);
    const readSocketId = React.useCallback(() => socket?.socketId ?? '', [socket]);
    React.useSyncExternalStore(subscribe, readSocketId, readSocketId);
    return socket;
}
