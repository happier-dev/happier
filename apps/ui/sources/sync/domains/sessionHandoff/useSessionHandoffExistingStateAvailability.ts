import * as React from 'react';
import { supportsExistingSessionHandoffState, type AgentId } from '@happier-dev/agents';
import { probeSessionHandoffCapability } from './probeSessionHandoffCapability';

export type SessionHandoffExistingStateAvailability =
    | Readonly<{ status: 'checking' | 'available' | 'unavailable' | 'unsupported_agent' }>
    | Readonly<{ status: 'error'; errorCode: string; errorMessage: string }>;

const CHECKING = { status: 'checking' } as const;
const AVAILABLE = { status: 'available' } as const;
const UNAVAILABLE = { status: 'unavailable' } as const;
const UNSUPPORTED_AGENT = { status: 'unsupported_agent' } as const;

/** A picker-only read. The daemon independently admits both peers before mutation. */
export function useSessionHandoffExistingStateAvailability(input: Readonly<{
    serverId: string | null;
    sourceMachineId: string | null;
    targetMachineId: string | null;
    agentId: AgentId | null;
}>): SessionHandoffExistingStateAvailability {
    const { serverId, sourceMachineId, targetMachineId, agentId } = input;
    const agentSupported = supportsExistingSessionHandoffState(agentId);
    const scope = `${serverId ?? ''}:${sourceMachineId ?? ''}:${targetMachineId ?? ''}`;
    const [result, setResult] = React.useState<Readonly<{ scope: string; availability: SessionHandoffExistingStateAvailability }> | null>(null);
    React.useEffect(() => {
        if (!agentSupported || !sourceMachineId || !targetMachineId || sourceMachineId === targetMachineId) return;
        let cancelled = false;
        void Promise.all([
            probeSessionHandoffCapability({ serverId, machineId: sourceMachineId }),
            probeSessionHandoffCapability({ serverId, machineId: targetMachineId }),
        ]).then(([source, target]) => {
            const failure = source.status === 'error' ? source : target.status === 'error' ? target : null;
            const availability = failure ?? (source.status === 'supported' && source.capability.existingState
                && target.status === 'supported' && target.capability.existingState ? AVAILABLE : UNAVAILABLE);
            if (!cancelled) setResult({ scope, availability });
        });
        return () => { cancelled = true; };
    }, [agentSupported, scope, serverId, sourceMachineId, targetMachineId]);
    if (!agentSupported) return UNSUPPORTED_AGENT;
    return result?.scope === scope ? result.availability : CHECKING;
}
