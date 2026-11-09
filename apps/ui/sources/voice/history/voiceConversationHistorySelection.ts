import { storage } from '@/sync/domains/state/storageStore';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListPageSelection } from '@/sync/domains/session/listing/sessionListQueryController';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';

/** Voice custody is owner-private; only the hydrated client summary can select it. */
export const selectVoiceConversationHistorySession: SessionListPageSelection = (sessionId, serverId) => {
    const row = readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, serverId, sessionId);
    if (!row) return null;
    if (!isSessionAccessOwner(row.access, row.accessLevel)) return false;
    if (row.metadata === null || row.metadataUnavailable === true) return null;
    return isVoiceConversationCustodySessionMetadata(row.metadata);
};
