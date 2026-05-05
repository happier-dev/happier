import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { deriveDirectSessionAttentionHasUnread } from '@/sync/domains/session/directSessions/readDirectSessionAttention';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import {
    resolveLastViewedSessionSeq,
    type LastViewedSessionSeqInput,
} from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import type { Metadata } from '@/sync/domains/state/storageTypes';

export type SessionReadState = 'read' | 'unread' | 'empty';

export type SessionReadStateAction =
    | { kind: 'mark-read'; visible: true; targetState: 'read' }
    | { kind: 'mark-unread'; visible: true; targetState: 'unread' }
    | { kind: 'none'; visible: false };

type SessionReadStateInput = LastViewedSessionSeqInput & Readonly<{
    seq: number;
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

export function deriveSessionReadState(session: SessionReadStateInput): SessionReadState {
    const metadata = session.metadata as Metadata | null | undefined;
    if (readDirectSessionLink(metadata)) {
        const directSessionHasUnread = deriveDirectSessionAttentionHasUnread(metadata);
        if (directSessionHasUnread === true) return 'unread';
        if (directSessionHasUnread === false) return 'read';
    }

    const sessionSeq = Math.max(0, Math.trunc(session.seq));
    if (sessionSeq <= 0) {
        return 'empty';
    }

    const hasUnread = computeHasUnreadActivity({
        sessionSeq,
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
        lastViewedPendingActivityAt: resolveLegacyPendingActivityAt(session.metadata),
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
