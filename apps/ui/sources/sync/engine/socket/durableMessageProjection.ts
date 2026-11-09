import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import type { SessionMessageObservationFactsV1} from '@happier-dev/protocol/sessions';
import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { storedSessionMessageAttentionImpact } from '@happier-dev/session-core/messages';
import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import {
    deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { buildMessageSessionProjectionPatch } from '../sessions/messageSessionProjection';

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Scalar/unread observation shared by the focused and secondary Home sockets. */
export function buildCacheOnlyDurableMessageProjectionPatch(params: Readonly<{
    renderable: SessionListRenderableSession;
    updateData: ApiUpdateContainer;
    rawMessage: SessionMessageV1 | SessionMessageObservationFactsV1 | undefined;
    messageSeq: number | null;
}>): Partial<SessionListRenderableSession> {
    const { renderable, updateData, rawMessage, messageSeq } = params;
    const attentionImpact = storedSessionMessageAttentionImpact(rawMessage);
    const scalarPatch = buildMessageSessionProjectionPatch({
        session: renderable,
        updateData,
        rawMessage,
        messageSeq,
        updateType: updateData.body.t === 'message-updated' ? 'message-updated' : 'new-message',
        projectionOnly: true,
    });
    const nextSessionSeq = scalarPatch.seq ?? renderable.seq ?? 0;
    const updateCreatedAt = finiteNumber(updateData.createdAt);
    const messageCreatedAt = finiteNumber(rawMessage?.createdAt);
    const nextMeaningfulActivityAt = attentionImpact.affectsMeaningfulActivity
        ? messageCreatedAt ?? updateCreatedAt
        : null;
    const readableActivity = attentionImpact.affectsUnread || attentionImpact.affectsMeaningfulActivity
        ? {
            latestCommittedMessageSeq: attentionImpact.affectsUnread ? messageSeq : null,
            latestCommittedMessageCreatedAt: attentionImpact.affectsMeaningfulActivity ? nextMeaningfulActivityAt : null,
        }
        : undefined;

    return {
        ...scalarPatch,
        hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch({
            viewer: renderable.viewer,
            owner: renderable.owner,
            access: renderable.access,
            accessLevel: renderable.accessLevel,
            metadata: undefined,
            nextSessionSeq,
            nextLastViewedSessionSeq: renderable.lastViewedSessionSeq ?? null,
            nextLatestTurnStatus: renderable.latestTurnStatus ?? null,
            nextLatestReadyEventSeq: renderable.latestReadyEventSeq ?? null,
            readableActivity,
            previousHasUnreadMessages: renderable.hasUnreadMessages,
            previousLastViewedSessionSeq: resolveLastViewedSessionSeq(renderable),
            recomputeUnread: attentionImpact.affectsUnread && messageSeq !== null,
        }),
    };
}
