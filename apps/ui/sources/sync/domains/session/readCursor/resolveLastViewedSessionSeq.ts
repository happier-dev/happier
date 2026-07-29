import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type LastViewedSessionSeqInput = Readonly<{
    lastViewedSessionSeq?: number | null;
    metadata?: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
}>;

export function resolveLastViewedSessionSeq(session: LastViewedSessionSeqInput): number | undefined {
    if (typeof session.lastViewedSessionSeq === 'number' && Number.isFinite(session.lastViewedSessionSeq)) {
        return Math.max(0, Math.trunc(session.lastViewedSessionSeq));
    }

    const metadata = readSessionOwnerMetadataView({
        metadataLayoutVersion: session.metadataLayoutVersion,
        metadata: session.metadata ?? null,
        ownerMetadataView: session.ownerMetadataView,
    });
    if (!metadata || typeof metadata !== 'object') {
        return undefined;
    }
    const readStateV1 = (metadata as { readStateV1?: unknown }).readStateV1;
    if (!readStateV1 || typeof readStateV1 !== 'object') {
        return undefined;
    }
    const legacySessionSeq = (readStateV1 as { sessionSeq?: unknown }).sessionSeq;
    if (typeof legacySessionSeq === 'number' && Number.isFinite(legacySessionSeq)) {
        return Math.max(0, Math.trunc(legacySessionSeq));
    }

    return undefined;
}
