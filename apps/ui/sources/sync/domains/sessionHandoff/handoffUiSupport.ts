import { evaluateVendorHandoffEligibility, resolveAgentIdFromFlavor } from '@happier-dev/agents';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

type SessionLike = Readonly<{
    metadata?: Record<string, unknown> | null;
}>;

export function canHandoffConversation(params: Readonly<{ sessionId?: string | null; session: SessionLike | null | undefined }>): boolean {
    const metadata = params.session?.metadata ?? null;
    if (!metadata) return false;

    const reachableMachineId = typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? (readMachineTargetForSession(params.sessionId)?.machineId ?? '')
        : '';
    const machineId = reachableMachineId || (typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '');
    if (!machineId) return false;

    const agentId = resolveAgentIdFromFlavor(metadata.flavor);
    if (!agentId) return false;

    const sessionStorageMode = metadata.directSessionV1 ? 'direct' : 'persisted';
    return evaluateVendorHandoffEligibility({
        agentId,
        metadata,
        storageMode: sessionStorageMode,
    }).eligible === true;
}
