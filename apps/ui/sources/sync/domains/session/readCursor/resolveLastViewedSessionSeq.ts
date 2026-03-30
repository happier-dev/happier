import type { Session } from '@/sync/domains/state/storageTypes';

export function resolveLastViewedSessionSeq(session: Pick<Session, 'lastViewedSessionSeq' | 'metadata'>): number | undefined {
    if (typeof session.lastViewedSessionSeq === 'number' && Number.isFinite(session.lastViewedSessionSeq)) {
        return Math.max(0, Math.trunc(session.lastViewedSessionSeq));
    }

    const legacySessionSeq = session.metadata?.readStateV1?.sessionSeq;
    if (typeof legacySessionSeq === 'number' && Number.isFinite(legacySessionSeq)) {
        return Math.max(0, Math.trunc(legacySessionSeq));
    }

    return undefined;
}
