import { evaluateVendorHandoffEligibility, isAgentId, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readExternalSessionLink } from '../session/external/readExternalSessionLink';
import { resolveSessionHandoffSourceMachineId } from './resolveSessionHandoffSourceMachineId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type SessionLike = Readonly<{
    metadata?: Record<string, unknown> | null;
    metadataLayoutVersion?: number;
    ownerMetadataView?: Record<string, unknown> | null;
}>;

export function canHandoffConversation(params: Readonly<{ sessionId?: string | null; session: SessionLike | null | undefined }>): boolean {
    const metadata = params.session
        ? readSessionOwnerMetadataView({
            metadataLayoutVersion: params.session.metadataLayoutVersion,
            metadata: params.session.metadata ?? null,
            ownerMetadataView: params.session.ownerMetadataView,
        })
        : null;
    if (!metadata) return false;

    const machineId = resolveSessionHandoffSourceMachineId({
        reachableMachineId: typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
            ? (readMachineTargetForSession(params.sessionId)?.machineId ?? '')
            : '',
        sessionMetadata: metadata,
    });
    if (!machineId) return false;

    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    if (!agentId) return false;
    if (!isAgentId(agentId)) return false;

    const sessionStorageMode = readExternalSessionLink(metadata) ? 'direct' : 'persisted';
    return evaluateVendorHandoffEligibility({
        agentId,
        storageMode: sessionStorageMode,
        metadata,
    }).eligible === true;
}
