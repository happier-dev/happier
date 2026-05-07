export type LastViewedSessionSeqInput = Readonly<{
    lastViewedSessionSeq?: number | null;
    metadata?: unknown;
}>;

export function resolveLastViewedSessionSeq(session: LastViewedSessionSeqInput): number | undefined {
    if (typeof session.lastViewedSessionSeq === 'number' && Number.isFinite(session.lastViewedSessionSeq)) {
        return Math.max(0, Math.trunc(session.lastViewedSessionSeq));
    }

    const metadata = session.metadata;
    const readStateV1 = metadata && typeof metadata === 'object'
        ? (metadata as { readStateV1?: unknown }).readStateV1
        : null;
    const legacySessionSeq = readStateV1 && typeof readStateV1 === 'object'
        ? (readStateV1 as { sessionSeq?: unknown }).sessionSeq
        : undefined;
    if (typeof legacySessionSeq === 'number' && Number.isFinite(legacySessionSeq)) {
        return Math.max(0, Math.trunc(legacySessionSeq));
    }

    return undefined;
}
