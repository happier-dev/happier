import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import {
    resolveLastViewedSessionSeq,
    type LastViewedSessionSeqInput,
} from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';

export type SessionReadState = 'read' | 'unread' | 'empty';

export type SessionReadStateAction =
    | { kind: 'mark-read'; visible: true; targetState: 'read' }
    | { kind: 'mark-unread'; visible: true; targetState: 'unread' }
    | { kind: 'none'; visible: false };

type SessionReadStateInput = LastViewedSessionSeqInput & Readonly<{
    seq: number;
    accessLevel?: 'view' | 'edit' | 'admin' | null;
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
