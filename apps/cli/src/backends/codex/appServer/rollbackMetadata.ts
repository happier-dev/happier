import type { Metadata } from '@/api/types';
import {
    buildSessionRollbackRangesV1,
    readSessionRollbackRangesV1FromMetadata,
    type SessionRollbackRangeV1,
    type SessionRollbackTarget,
} from '@happier-dev/protocol';

type RollbackMetadataSession = Readonly<{
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
}>;

export type CompletedTurnSeqRange = Readonly<{
    userMessageSeq: number;
    startSeqInclusive: number;
    endSeqInclusive: number;
}>;

export function captureCompletedTurnSeqRange(params: Readonly<{
    userMessageSeq?: number;
    startSeqInclusive: number;
    endSeqInclusive: number;
}>): CompletedTurnSeqRange | null {
    const userMessageSeq = Number.isFinite(params.userMessageSeq) ? Math.trunc(params.userMessageSeq as number) : Math.trunc(params.startSeqInclusive);
    const startSeqInclusive = Number.isFinite(params.startSeqInclusive) ? Math.trunc(params.startSeqInclusive) : -1;
    const endSeqInclusive = Number.isFinite(params.endSeqInclusive) ? Math.trunc(params.endSeqInclusive) : -1;
    if (userMessageSeq < 0 || startSeqInclusive < 0 || endSeqInclusive < startSeqInclusive) {
        return null;
    }
    return { userMessageSeq, startSeqInclusive, endSeqInclusive };
}

export async function publishRollbackRangeMetadata(params: Readonly<{
    session: RollbackMetadataSession;
    target: SessionRollbackTarget;
    range: CompletedTurnSeqRange;
    rolledBackAt?: number;
}>): Promise<void> {
    const rolledBackAt = typeof params.rolledBackAt === 'number' && Number.isFinite(params.rolledBackAt)
        ? Math.trunc(params.rolledBackAt)
        : Date.now();

    await Promise.resolve(params.session.updateMetadata((metadata) => {
        const existing = readSessionRollbackRangesV1FromMetadata(metadata);
        const nextRange: SessionRollbackRangeV1 = {
            target: params.target,
            startSeqInclusive: params.range.startSeqInclusive,
            endSeqInclusive: params.range.endSeqInclusive,
            rolledBackAt,
        };
        return {
            ...metadata,
            sessionRollbackRangesV1: buildSessionRollbackRangesV1({
                updatedAt: rolledBackAt,
                ranges: [...(existing?.ranges ?? []), nextRange],
            }),
        };
    }));
}

export async function publishLatestTurnRollbackRangeMetadata(params: Readonly<{
    session: RollbackMetadataSession;
    range: CompletedTurnSeqRange;
    rolledBackAt?: number;
}>): Promise<void> {
    await publishRollbackRangeMetadata({
        session: params.session,
        target: { type: 'latest_turn' },
        range: params.range,
        ...(typeof params.rolledBackAt === 'number' ? { rolledBackAt: params.rolledBackAt } : {}),
    });
}
