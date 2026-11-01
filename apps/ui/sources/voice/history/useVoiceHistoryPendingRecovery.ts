import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSession } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

export type VoiceHistoryPendingRecovery = Readonly<{
    address: SessionAddress;
    openAction: Readonly<{ actionId: 'workspace.tabs.open'; input: Readonly<{ href: string }> }>;
}>;

/**
 * History borrows the exact conversation/request address from its binding, independently of
 * the person-facing coding target. Only that Session's pushed summary is needed here; opening
 * the incumbent Session route lets Pending load its own rows and recovery Actions on demand.
 */
export function readVoiceHistoryPendingRecovery(address: SessionAddress | null, session: Session | null): VoiceHistoryPendingRecovery | null {
    if (!address || !session
        || !isVoiceConversationCustodySessionMetadata(readSessionOwnerMetadataView(session))) return null;
    const awareness = projectUiSessionAwareness(session, Date.now(), { includeTitle: false, includeWorkspace: false });
    // This is the shared owner's already-classified fact, including when a failure or real
    // request owns the primary word. History never classifies or replays individual inputs.
    if (!isSessionAwarenessContentReadableV1(awareness.encryption)
        || !awareness.operational.reasons.includes('blocked_input')) return null;
    return { address, openAction: { actionId: 'workspace.tabs.open', input: {
        href: buildScopedSessionRouteHref({ sessionId: address.sessionId, serverId: address.serverId }),
    } } };
}

export function useVoiceHistoryPendingRecovery(address: SessionAddress | null): VoiceHistoryPendingRecovery | null {
    const session = useSession(address?.sessionId ?? '', address?.serverId);
    return readVoiceHistoryPendingRecovery(address, session);
}
