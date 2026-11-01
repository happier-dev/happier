import { z } from 'zod';

import {
  PrimaryTurnStatusV1Schema,
  SessionRuntimeIssueV1Schema,
} from '../control/runtimeIssueV1.js';
import { lazySchema } from '../../lazySchema.js';

export const SessionIndexedIdentifierMaxLengthV1 = 191;
export const SessionTurnIdentifierV1Schema = lazySchema(() => z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1));
export const SessionTurnProviderV1Schema = lazySchema(() => z.string().trim().min(1).max(128));
export const SessionTurnTimestampV1Schema = lazySchema(() => z.number().finite().int().nonnegative());
export const SessionTurnSeqV1Schema = lazySchema(() => z.number().finite().int().nonnegative());

export const SessionTurnLifecycleStatusV1Schema = PrimaryTurnStatusV1Schema;
export type SessionTurnLifecycleStatusV1 = z.infer<typeof SessionTurnLifecycleStatusV1Schema>;

export const SessionTurnRollbackStateV1Schema = lazySchema(() => z.enum([
  'not_eligible',
  'eligible',
  'rolled_back',
]));
export type SessionTurnRollbackStateV1 = z.infer<typeof SessionTurnRollbackStateV1Schema>;

export const SessionTurnTranscriptAnchorsV1Schema = lazySchema(() => z
  .object({
    startUserMessageSeq: SessionTurnSeqV1Schema.optional(),
    userMessageSeqs: z.array(SessionTurnSeqV1Schema).readonly().optional(),
    startSeqInclusive: SessionTurnSeqV1Schema.optional(),
    endSeqInclusive: SessionTurnSeqV1Schema.nullable().optional(),
  })
  .passthrough()
  .readonly());
export type SessionTurnTranscriptAnchorsV1 = z.infer<typeof SessionTurnTranscriptAnchorsV1Schema>;

export const SessionTurnRollbackFacetBaseV1Schema = lazySchema(() => z
  .object({
    state: SessionTurnRollbackStateV1Schema,
    reason: z.string().trim().min(1).max(256).optional(),
    providerRollbackOrdinal: z.number().finite().int().nonnegative().optional(),
  })
  .passthrough());

export const SessionTurnRollbackFacetV1Schema = lazySchema(() => SessionTurnRollbackFacetBaseV1Schema
  .extend({
    updatedAt: SessionTurnTimestampV1Schema,
  })
  .readonly());
export type SessionTurnRollbackFacetV1 = z.infer<typeof SessionTurnRollbackFacetV1Schema>;

export const SessionTurnV1Schema = lazySchema(() => z
  .object({
    turnId: SessionTurnIdentifierV1Schema,
    provider: SessionTurnProviderV1Schema.optional(),
    providerTurnId: SessionTurnIdentifierV1Schema.optional(),
    status: SessionTurnLifecycleStatusV1Schema,
    startedAt: SessionTurnTimestampV1Schema,
    updatedAt: SessionTurnTimestampV1Schema,
    terminalAt: SessionTurnTimestampV1Schema.optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema.optional(),
    rollback: SessionTurnRollbackFacetV1Schema.optional(),
    lastMutationId: SessionTurnIdentifierV1Schema.optional(),
  })
  .passthrough()
  .readonly());
export type SessionTurnV1 = z.infer<typeof SessionTurnV1Schema>;

export function buildSessionTurnV1(params: Readonly<SessionTurnV1 & Record<string, unknown>>): SessionTurnV1 {
  return {
    ...params,
    ...(params.transcriptAnchors
      ? {
          transcriptAnchors: {
            ...params.transcriptAnchors,
            ...(params.transcriptAnchors.userMessageSeqs
              ? { userMessageSeqs: [...params.transcriptAnchors.userMessageSeqs] }
              : {}),
          },
        }
      : {}),
    ...(params.rollback ? { rollback: { ...params.rollback } } : {}),
  };
}

function isFiniteSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isCompletedRollbackStart(turn: SessionTurnV1): boolean {
  return turn.status === 'completed'
    && isFiniteSeq(turn.transcriptAnchors?.startUserMessageSeq)
    && isFiniteSeq(turn.transcriptAnchors?.endSeqInclusive);
}

export function listCompletedSessionTurns(turns: readonly SessionTurnV1[] | null | undefined): readonly SessionTurnV1[] {
  return turns?.filter(isCompletedRollbackStart) ?? [];
}

export function findCompletedSessionTurnByStartUserSeq(
  turns: readonly SessionTurnV1[] | null | undefined,
  seq: number,
): SessionTurnV1 | null {
  if (!isFiniteSeq(seq)) return null;
  return listCompletedSessionTurns(turns).find((turn) => turn.transcriptAnchors?.startUserMessageSeq === seq) ?? null;
}

export function countCompletedSessionTurnsFromStartSeq(
  turns: readonly SessionTurnV1[] | null | undefined,
  seq: number,
): number | null {
  if (!isFiniteSeq(seq)) return null;
  const completedTurns = listCompletedSessionTurns(turns);
  const targetIndex = completedTurns.findIndex((turn) => turn.transcriptAnchors?.startUserMessageSeq === seq);
  if (targetIndex < 0) return null;
  return completedTurns.length - targetIndex;
}

export function resolveLatestCompletedSessionTurn(
  turns: readonly SessionTurnV1[] | null | undefined,
): SessionTurnV1 | null {
  const completedTurns = listCompletedSessionTurns(turns);
  return completedTurns[completedTurns.length - 1] ?? null;
}
