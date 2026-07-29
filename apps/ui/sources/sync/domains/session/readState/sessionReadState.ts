import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { summarizeSessionListReadableActivityFromMessageRecords } from '@/sync/domains/session/listing/sessionListRenderable';
import { deriveExternalSessionAttentionHasUnread } from '@/sync/domains/session/external/readExternalSessionAttention';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    resolveLastViewedSessionSeq,
    type LastViewedSessionSeqInput,
} from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { resolveSessionListReadableSeq } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type SessionReadState = 'read' | 'unread' | 'empty';

export type SessionReadStateAction =
    | { kind: 'mark-read'; visible: true; targetState: 'read' }
    | { kind: 'mark-unread'; visible: true; targetState: 'unread' }
    | { kind: 'none'; visible: false };

type SessionReadStateInput = LastViewedSessionSeqInput & Readonly<{
    id?: string;
    seq: number;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestReadyEventSeq?: number | null;
    hasUnreadMessages?: unknown;
}>;

function resolveLegacyPendingActivityAt(metadata: unknown): number | undefined {
    if (!metadata || typeof metadata !== 'object') {
        return undefined;
    }
    const readStateV1 = (metadata as { readStateV1?: unknown }).readStateV1;
    if (!readStateV1 || typeof readStateV1 !== 'object') {
        return undefined;
    }
    const pendingActivityAt = (readStateV1 as { pendingActivityAt?: unknown }).pendingActivityAt;
    return typeof pendingActivityAt === 'number' && Number.isFinite(pendingActivityAt)
        ? pendingActivityAt
        : undefined;
}

function resolveReadableActivityForReadState(session: SessionReadStateInput) {
    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
    if (!sessionId) return undefined;

    const storageState = readRegisteredStorageState();
    const sessionMessages = storageState?.sessionMessages?.[sessionId];
    if (!sessionMessages) return undefined;
    if ((sessionMessages as { isLoaded?: unknown }).isLoaded !== true) return undefined;

    return summarizeSessionListReadableActivityFromMessageRecords(
        sessionMessages.messageIdsOldestFirst,
        sessionMessages.messagesById,
    );
}

function readRenderableHasUnreadMessages(session: SessionReadStateInput): boolean | null {
    if (session.hasUnreadMessages === true) return true;
    if (session.hasUnreadMessages === false) return false;

    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
    if (!sessionId) return null;

    const storageState = readRegisteredStorageState();
    const renderable = (storageState as {
        sessionListRenderables?: Record<string, { hasUnreadMessages?: unknown } | undefined>;
    } | null)?.sessionListRenderables?.[sessionId];
    if (renderable?.hasUnreadMessages === true) return true;
    if (renderable?.hasUnreadMessages === false) return false;
    return null;
}

export function deriveSessionReadState(session: SessionReadStateInput): SessionReadState {
    const metadata = readSessionOwnerMetadataView({
        metadataLayoutVersion: session.metadataLayoutVersion,
        metadata: session.metadata as Metadata | null | undefined,
        ownerMetadataView: session.ownerMetadataView,
    });
    if (readExternalSessionLink(metadata)) {
        const externalSessionHasUnread = deriveExternalSessionAttentionHasUnread(metadata);
        if (externalSessionHasUnread === true) return 'unread';
        if (externalSessionHasUnread === false) return 'read';
    }

    if (readRenderableHasUnreadMessages(session) === true) {
        return 'unread';
    }

    const readableSeq = resolveSessionListReadableSeq(session, resolveReadableActivityForReadState(session));
    if (readableSeq <= 0) {
        return 'empty';
    }

    const hasUnread = computeHasUnreadActivity({
        sessionSeq: readableSeq,
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
        lastViewedPendingActivityAt: resolveLegacyPendingActivityAt(metadata),
    });

    return hasUnread ? 'unread' : 'read';
}

export function resolveSessionReadStateAction(session: SessionReadStateInput): SessionReadStateAction {
    const readState = deriveSessionReadState(session);
    if (readState === 'empty') {
        return { kind: 'none', visible: false };
    }
    if (readState === 'unread') {
        return { kind: 'mark-read', visible: true, targetState: 'read' };
    }
    return { kind: 'mark-unread', visible: true, targetState: 'unread' };
}
