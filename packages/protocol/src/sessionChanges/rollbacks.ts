import { z } from 'zod';

import type { SessionRollbackRangeV1, SessionRollbackRangesV1, TurnChangeSet } from './types.js';

export const SessionRollbackTargetSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('latest_turn') }).strict(),
    z.object({
        type: z.literal('before_user_message'),
        userMessageSeq: z.number().int().nonnegative(),
    }).strict(),
]);

export const SessionRollbackRangeV1Schema = z.object({
    target: SessionRollbackTargetSchema,
    startSeqInclusive: z.number().int().nonnegative(),
    endSeqInclusive: z.number().int().nonnegative(),
    rolledBackAt: z.number().finite(),
}).refine((value) => value.endSeqInclusive >= value.startSeqInclusive, {
    message: 'endSeqInclusive must be greater than or equal to startSeqInclusive',
    path: ['endSeqInclusive'],
}).passthrough();

export const SessionRollbackRangesV1Schema = z.object({
    v: z.literal(1),
    updatedAt: z.number().finite(),
    ranges: z.array(SessionRollbackRangeV1Schema),
}).passthrough();

export function buildSessionRollbackRangesV1(params: Readonly<{
    updatedAt: number;
    ranges: ReadonlyArray<SessionRollbackRangeV1>;
}>): SessionRollbackRangesV1 {
    return {
        v: 1,
        updatedAt: params.updatedAt,
        ranges: [...params.ranges],
    };
}

export function readSessionRollbackRangesV1FromMetadata(metadata: unknown): SessionRollbackRangesV1 | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const raw = (metadata as Record<string, unknown>).sessionRollbackRangesV1;
    const parsed = SessionRollbackRangesV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

function isTurnInsideRollbackRange(turn: TurnChangeSet, range: SessionRollbackRangeV1): boolean {
    return turn.seqRange.startSeqInclusive >= range.startSeqInclusive
        && turn.seqRange.endSeqInclusive <= range.endSeqInclusive;
}

export function excludeRolledBackTurns(params: Readonly<{
    turns: readonly TurnChangeSet[];
    rollbackRanges: readonly SessionRollbackRangeV1[];
}>): TurnChangeSet[] {
    if (params.rollbackRanges.length === 0) return [...params.turns];
    return params.turns.filter((turn) => !params.rollbackRanges.some((range) => isTurnInsideRollbackRange(turn, range)));
}
