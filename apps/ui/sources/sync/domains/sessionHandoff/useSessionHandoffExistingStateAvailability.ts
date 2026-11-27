import * as React from 'react';
import { SessionHandoffCapabilityV3Schema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveSessionHandoffRuntimeConfig } from './sessionHandoffRuntimeConfig';

function useExistingStatePeerCapability(serverId: string | null, machineId: string | null): boolean | null {
    const [result, setResult] = React.useState<Readonly<{
        serverId: string | null;
        machineId: string;
        available: boolean;
    }> | null>(null);
    React.useEffect(() => {
        if (!machineId) {
            setResult(null);
            return;
        }
        let cancelled = false;
        const probe = async (): Promise<boolean> => {
            try {
                const raw = await machineRpcWithServerScope<unknown, Record<string, never>>({
                    serverId, machineId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET,
                    payload: {}, timeoutMs: resolveSessionHandoffRuntimeConfig().machineRpcPollTimeoutMs,
                });
                const parsed = SessionHandoffCapabilityV3Schema.safeParse(raw);
                return parsed.success && parsed.data.existingState === true;
            } catch {
                return false;
            }
        };
        void probe().then(available => {
            if (!cancelled) setResult({ serverId, machineId, available });
        });
        return () => { cancelled = true; };
    }, [serverId, machineId]);
    return result?.serverId === serverId && result.machineId === machineId ? result.available : null;
}

/** A picker-only read. The daemon independently admits both peers before mutation. */
export function useSessionHandoffExistingStateAvailability(input: Readonly<{
    serverId: string | null;
    sourceMachineId: string | null;
    targetMachineId: string | null;
}>): 'checking' | 'available' | 'unavailable' {
    const { serverId, sourceMachineId, targetMachineId } = input;
    const selectedPeer = sourceMachineId && targetMachineId && sourceMachineId !== targetMachineId;
    const source = useExistingStatePeerCapability(serverId, selectedPeer ? sourceMachineId : null);
    const target = useExistingStatePeerCapability(serverId, selectedPeer ? targetMachineId : null);
    if (source === null || target === null) return 'checking';
    return source && target ? 'available' : 'unavailable';
}
