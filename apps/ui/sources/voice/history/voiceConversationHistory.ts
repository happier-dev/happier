import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { StorageState } from '@/sync/store/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { isVoiceConversationCustodySessionMetadata, isVoiceConversationSystemSessionMetadata,
    shouldRetireLegacyVoiceConversationSession } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readVoiceHistoryPendingRecovery } from './useVoiceHistoryPendingRecovery';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol/sessions/control/contract';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { deriveSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/deriveSessionListActivity';
import { isSessionListRenderableNewerThanSession } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';

/** A demand-only projection of the existing Session list; never loads bodies or invents complete coverage. */
export function readVoiceConversationHistory(state: Pick<StorageState, 'sessions' | 'sessionListRowsByServerId'> & Partial<Pick<StorageState, 'sessionPending'>>,
    options?: Readonly<{ serverId: string; coverageComplete?: boolean }>) {
    let readableDisplays = true;
    const conversations = new Map<string, Readonly<{
        address: Readonly<{ serverId: string; sessionId: string }>;
        title: string;
        lastActivityAt: number;
        canContinue: boolean | null;
        hasBlockedInputs: boolean;
        pendingInputs: readonly Readonly<{ localId: string; reason: string | null }>[];
    }>>();
    for (const [serverId, rows] of Object.entries(state.sessionListRowsByServerId)) {
        if (options && !areServerProfileIdentifiersEquivalent(serverId, options.serverId)) continue;
        for (const row of Object.values(rows)) {
            if (!isSessionAccessOwner(row.access, row.accessLevel)) continue;
            if (row.metadata === null || row.metadataUnavailable === true) readableDisplays = false;
            if (!isVoiceConversationCustodySessionMetadata(row.metadata)) continue;
            const address = normalizeSessionAddress(options?.serverId ?? serverId, row.id);
            if (!address) continue;
            conversations.set(sessionAddressKey(address), { address, title: getSessionName(row, serverId, { snapshotOnly: true }),
                lastActivityAt: deriveSessionListMeaningfulActivityAt({ sessionMeaningfulActivityAt: row.meaningfulActivityAt,
                    sessionCreatedAt: row.createdAt, latestCommittedMessageCreatedAt: null, latestPendingMessageCreatedAt: null }) ?? row.createdAt,
                canContinue: readSystemSessionMetadataFromMetadata({ metadata: row.metadata })
                    ? isVoiceConversationSystemSessionMetadata(row.metadata) : null,
                hasBlockedInputs: (row.pendingBlockedCount ?? 0) > 0, pendingInputs: [] });
        }
    }
    for (const session of Object.values(state.sessions)) {
        if (options && !areServerProfileIdentifiersEquivalent(session.serverId, options.serverId)) continue;
        const address = normalizeSessionAddress(options?.serverId ?? session.serverId, session.id);
        if (!address) continue;
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId, address.serverId, address.sessionId);
        // The Session-list owner may have a newer display than the last opened body.
        if (row && isSessionListRenderableNewerThanSession(row, session)) continue;
        if (!isSessionAccessOwner(session.access, session.accessLevel)) {
            conversations.delete(sessionAddressKey(address));
            continue;
        }
        const metadata = readSessionOwnerMetadataView(session);
        if (!isVoiceConversationCustodySessionMetadata(metadata)) {
            conversations.delete(sessionAddressKey(address));
            continue;
        }
        const pendingInputs = (state.sessionPending?.[session.id]?.messages ?? [])
            .filter(row => row.pendingDeliveryStatus === 'blocked')
            .flatMap(row => row.localId === null ? [] : [{ localId: row.localId, reason: row.pendingDeliveryBlockedReason ?? null }]);
        conversations.set(sessionAddressKey(address), { address, title: getSessionName(session, address.serverId),
            lastActivityAt: deriveSessionListMeaningfulActivityAt({ sessionMeaningfulActivityAt: session.meaningfulActivityAt,
                sessionCreatedAt: session.createdAt, latestCommittedMessageCreatedAt: null, latestPendingMessageCreatedAt: null }) ?? session.createdAt,
            canContinue: isVoiceConversationSystemSessionMetadata(metadata) && !shouldRetireLegacyVoiceConversationSession({ metadata }),
            hasBlockedInputs: pendingInputs.length > 0 || readVoiceHistoryPendingRecovery(address, session) !== null, pendingInputs });
    }
    return { coverage: 'loaded' as const, coverageComplete: options?.coverageComplete === true && readableDisplays,
        conversations: [...conversations.values()]
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt || sessionAddressKey(a.address).localeCompare(sessionAddressKey(b.address))) };
}
