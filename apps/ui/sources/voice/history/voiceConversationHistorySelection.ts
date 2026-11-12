import { storage } from '@/sync/domains/state/storageStore';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListPageSelection } from '@/sync/domains/session/listing/sessionListQueryController';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { isVoiceConversationHistorySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Compact custody is sufficient; other hidden carriers need their full owner identity. */
export const selectVoiceConversationHistorySession: SessionListPageSelection = (sessionId, serverId) => {
    const state = storage.getState();
    const row = readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, sessionId);
    if (!row) return null;
    if (!isSessionAccessOwner(row.access, row.accessLevel)) return false;
    if (row.metadata === null || row.metadataUnavailable === true) return null;
    if (isVoiceConversationHistorySessionMetadata(row.metadata)) return true;
    const metadata = readVoiceSessionOwnerMetadataFromState(state, { serverId, sessionId });
    if (isVoiceConversationHistorySessionMetadata(metadata)) return true;
    const session = state.sessions[sessionId];
    const hydratedMetadata = session && areServerProfileIdentifiersEquivalent(session.serverId, serverId)
        ? readSessionOwnerMetadataView(session) : null;
    if (row.metadata.hiddenSystemSession === true && !hydratedMetadata) {
        return 'metadata_required';
    }
    return false;
};
