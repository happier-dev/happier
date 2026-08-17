import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

/**
 * Classification of a canonical Replay-seeded creation failure.
 *
 * `createSpawnedSession`'s Replay-seeded mode throws one coded error for both
 * the row-creation stage and the launch stage. Every Replay ingress still owns
 * its own result shape, so they share this reader rather than each re-deriving
 * the stage and codes from the error's private fields.
 */
export type ReplaySeededCreationFailure = Readonly<{
  /** `spawn` once the row exists and the launch was rejected; `creation` before that. */
  stage: 'creation' | 'spawn';
  errorCode: string;
  errorMessage: string;
  sessionId: string | null;
  /** Raw launch envelope, preserved so an ingress can return it unchanged. */
  spawnResponse: unknown;
  /**
   * Launch outcome an ingress can return directly: the producer's own envelope
   * when it answered, and a typed error when the transport threw instead. The
   * canonical creator settles the orphaned row in both cases, so an ingress must
   * never surface `null` here.
   */
  spawnResult: unknown;
}>;

export function readReplaySeededCreationFailure(error: unknown): ReplaySeededCreationFailure {
  const record = error !== null && typeof error === 'object'
    ? error as Readonly<Record<string, unknown>>
    : null;
  const details = record?.details !== null && typeof record?.details === 'object'
    ? record.details as Readonly<Record<string, unknown>>
    : null;
  const hasSpawnResponse = details !== null && 'spawnResponse' in details;
  const errorCode = typeof record?.code === 'string' && record.code.trim().length > 0
    ? record.code
    : SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
  const errorMessage = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Failed to create a replay-seeded session';
  const spawnResponse = hasSpawnResponse ? details.spawnResponse : null;
  const hasEnvelope = spawnResponse !== null && typeof spawnResponse === 'object';
  return {
    stage: hasSpawnResponse ? 'spawn' : 'creation',
    errorCode,
    errorMessage,
    sessionId: typeof details?.sessionId === 'string' && details.sessionId.trim().length > 0
      ? details.sessionId
      : null,
    spawnResponse,
    spawnResult: hasEnvelope
      ? spawnResponse
      : { type: 'error' as const, errorCode, errorMessage },
  };
}
