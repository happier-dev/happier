import { useSessionFileTransferAvailability } from './useSessionFileTransferAvailability';
import { useSessionRpcAvailabilityState } from '@/sync/domains/state/storage';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readSessionAttachmentUploadContext } from './sessionAttachmentUploadContext';

export function useSessionFileUploadAvailability(
    sessionId: string,
    sessionServerId?: string | null,
    purpose: 'workspaceFile' | 'attachment' = 'workspaceFile',
): boolean {
    const attachment = purpose === 'attachment';
    const serverId = usePreferredServerIdForSession({ sessionId, serverId: sessionServerId }, attachment);
    const { binding } = useServerCredentialAccountScopeBinding(attachment ? serverId : null);
    const { sessionRpcAvailable } = useSessionRpcAvailabilityState(attachment ? sessionId : null, serverId);
    // Match the actual uploader's exact Home/Account context. A Ready Session
    // does not need a Machine carrier for its attachment-only RPC authority.
    // The unqualified context is reserved by Sync for an admitted embed.
    const sessionBound = attachment ? readSessionAttachmentUploadContext(sessionId,
        binding?.isCurrent() && sessionRpcAvailable ? binding.scope : null) : undefined;
    // Arbitrary workspace files retain Machine authority; they cannot use the
    // Session attachment carrier, even when the Session can accept attachments.
    const machineAvailable = useSessionFileTransferAvailability(sessionId, sessionServerId, !sessionBound);
    return Boolean(sessionBound) || machineAvailable;
}
