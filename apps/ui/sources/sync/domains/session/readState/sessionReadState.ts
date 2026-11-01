import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { readStoredSessionMessagesReadProjectionFromStateLike } from '@/sync/domains/messages/readStoredSessionMessages';
import {
    resolveLastViewedSessionSeq,
    type LastViewedSessionSeqInput,
} from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import {
    resolveSessionReadableSeq,
    type ResolveSessionReadableSeqInput,
} from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

export type SessionReadState = 'read' | 'unread' | 'empty';

export type SessionReadStateAction =
    | { kind: 'mark-read'; visible: true; targetState: 'read' }
    | { kind: 'mark-unread'; visible: true; targetState: 'unread' }
    | { kind: 'none'; visible: false };

type SessionReadStateInput = LastViewedSessionSeqInput & Readonly<{
    id?: string;
    seq: number;
    latestReadyEventSeq?: unknown;
    latestMessageSeq?: unknown;
    latestTurnStatus?: ResolveSessionReadableSeqInput['latestTurnStatus'];
    accessLevel?: 'view' | 'edit' | 'admin' | null;
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

function readSessionMessagesReadProjectionForReadState(session: SessionReadStateInput): NonNullable<ResolveSessionReadableSeqInput['messagesProjection']> | null {
    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
    if (!sessionId) return null;
    const storageState = readRegisteredStorageState();
    if (!storageState) return null;
    const sessionMessages = storageState.sessionMessages?.[sessionId];
    if (sessionMessages?.isLoaded !== true) return null;
    return readStoredSessionMessagesReadProjectionFromStateLike(sessionMessages);
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
    const renderableHasUnreadMessages = readRenderableHasUnreadMessages(session);
    if (renderableHasUnreadMessages === true) {
        return 'unread';
    }
    const messagesProjection = readSessionMessagesReadProjectionForReadState(session);
    const readableSeq = resolveSessionReadableSeq({
        messagesProjection,
        latestMessageSeq: messagesProjection === null
            ? session.latestMessageSeq
            : null,
        sessionSeq: session.seq,
        latestReadyEventSeq: session.latestReadyEventSeq,
        latestTurnStatus: session.latestTurnStatus ?? null,
        includeTerminalSessionSeq: true,
    });
    if (readableSeq == null || readableSeq <= 0) {
        return 'empty';
    }

    const hasUnread = computeHasUnreadActivity({
        sessionSeq: readableSeq,
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
        lastViewedPendingActivityAt: resolveLegacyPendingActivityAt(session.metadata),
    });

    return hasUnread ? 'unread' : 'read';
}

export function resolveSessionReadStateAction(session: SessionReadStateInput): SessionReadStateAction {
    if (session.accessLevel === 'view') {
        return { kind: 'none', visible: false };
    }

    const readState = deriveSessionReadState(session);
    if (readState === 'empty') {
        return { kind: 'none', visible: false };
    }
    if (readState === 'unread') {
        return { kind: 'mark-read', visible: true, targetState: 'read' };
    }
    return { kind: 'mark-unread', visible: true, targetState: 'unread' };
}
