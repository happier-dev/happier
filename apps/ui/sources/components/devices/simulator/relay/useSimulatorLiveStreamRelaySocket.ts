import * as React from 'react';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import {
    resolveServerScopedMachineLiveStreamRelaySocket,
    type ServerScopedMachineLiveStreamRelaySocket,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';

/**
 * Resolves the production `server_relay` socket for a simulator's host machine (Phase 8.1b).
 *
 * Gated behind the `devices.simulatorPreview` feature decision and a concrete machine id so
 * no socket is opened while the surface is unreachable (the gate flip is owned by the 5.3
 * representation-migration lane). The socket is disconnected on teardown / target change.
 */
export function useSimulatorLiveStreamRelaySocket(input: Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
}>): ServerScopedMachineLiveStreamRelaySocket | null {
    const enabled = input.enabled ?? true;
    const machineId = String(input.machineId ?? '').trim();
    const serverId = String(input.serverId ?? '').trim();

    const featureScope = React.useMemo(() => (
        serverId
            ? { scopeKind: 'spawn' as const, serverId }
            : { scopeKind: 'runtime' as const }
    ), [serverId]);
    const featureDecision = useFeatureDecision('devices.simulatorPreview', featureScope);
    const featureEnabled = featureDecision?.state === 'enabled';

    const [socket, setSocket] = React.useState<ServerScopedMachineLiveStreamRelaySocket | null>(null);

    React.useEffect(() => {
        if (!enabled || !featureEnabled || !machineId) {
            setSocket(null);
            return;
        }

        let disposed = false;
        let resolved: ServerScopedMachineLiveStreamRelaySocket | null = null;

        resolveServerScopedMachineLiveStreamRelaySocket({
            machineId,
            serverId: serverId || null,
        })
            .then((next) => {
                if (disposed) {
                    next.disconnect();
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
            resolved?.disconnect();
            setSocket(null);
        };
    }, [enabled, featureEnabled, machineId, serverId]);

    return socket;
}
