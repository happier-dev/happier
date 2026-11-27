import { TodoClaimAttemptBindingV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';

type TodoClaimAttemptBindingV1 = ReturnType<typeof TodoClaimAttemptBindingV1ProtocolSchema.parse>;

/**
 * A Happier Task's exact-read `detailData` (written by `taskGetResult` in `source.ts`): its canonical state, the
 * Run that last worked on it, and its live claim. The detail reads it back through this one reader; anything else is
 * no fact.
 */
export type InternalTaskDetailDataV1 = Readonly<{
  state?: string;
  runLink?: Readonly<{ sessionId: string; runId: string }>;
  /** The attempt still holding the Task; its release is read from that Session's own facts. */
  claim?: Readonly<{ attemptBinding: TodoClaimAttemptBindingV1; claimedAt?: number }>;
}>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function readInternalTaskDetailDataV1(
  value: unknown,
): InternalTaskDetailDataV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  const link = record.runLink;
  const runLink =
    link !== null &&
    typeof link === 'object' &&
    !Array.isArray(link) &&
    nonEmptyString((link as Record<string, unknown>).sessionId) &&
    nonEmptyString((link as Record<string, unknown>).runId)
      ? {
          sessionId: (link as { sessionId: string }).sessionId,
          runId: (link as { runId: string }).runId,
        }
      : undefined;
  const claim = record.claim !== null && typeof record.claim === 'object' && !Array.isArray(record.claim)
    ? (record.claim as Record<string, unknown>) : undefined;
  const attemptBinding = claim === undefined ? undefined : TodoClaimAttemptBindingV1ProtocolSchema.safeParse(claim.attemptBinding);
  return {
    ...(nonEmptyString(record.state) ? { state: record.state } : {}),
    ...(runLink === undefined ? {} : { runLink }),
    ...(attemptBinding?.success !== true ? {} : { claim: { attemptBinding: attemptBinding.data,
      ...(typeof claim?.claimedAt === 'number' ? { claimedAt: claim.claimedAt } : {}) } }),
  };
}
