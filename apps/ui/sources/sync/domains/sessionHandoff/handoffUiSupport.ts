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
    const topLevelMachineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
    const directSessionMachineId = (() => {
        const directSessionV1 = (metadata as { directSessionV1?: unknown }).directSessionV1;
        if (!directSessionV1 || typeof directSessionV1 !== 'object' || Array.isArray(directSessionV1)) return '';
        const machineId = (directSessionV1 as { machineId?: unknown }).machineId;
        return typeof machineId === 'string' ? machineId.trim() : '';
    })();

    const machineId = reachableMachineId || topLevelMachineId || directSessionMachineId;
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
