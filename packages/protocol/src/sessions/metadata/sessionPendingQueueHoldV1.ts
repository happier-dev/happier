import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PendingLocalIdSchema, readPendingLocalId } from '../pending/pendingLocalId.js';

export const SESSION_PENDING_QUEUE_HOLD_METADATA_KEY = 'sessionPendingQueueHoldV1' as const;
export const SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS = 5 * 60_000;

export const SessionPendingQueueHoldEntryV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    holdId: z.string().check(z.trim(), z.minLength(1)),
    kind: z.literal('pending_message_edit'),
    localId: PendingLocalIdSchema,
    updatedAtMs: z.number().check(z.int(), z.nonnegative()),
    expiresAtMs: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionPendingQueueHoldEntryV1 = z.infer<typeof SessionPendingQueueHoldEntryV1Schema>;

export const SessionPendingQueueHoldV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    holdsById: z.record(z.string().check(z.trim(), z.minLength(1)), SessionPendingQueueHoldEntryV1Schema),
  }));
export type SessionPendingQueueHoldV1 = z.infer<typeof SessionPendingQueueHoldV1Schema>;

export type WriteSessionPendingQueueHoldV1Input = Readonly<{
  holdId: string;
  localId: string;
  updatedAtMs: number;
  expiresAtMs: number;
}>;

function toMetadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

function normalizeTimestampMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function readSessionPendingQueueHoldV1FromMetadata(metadata: unknown): SessionPendingQueueHoldV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Record<string, unknown>)[SESSION_PENDING_QUEUE_HOLD_METADATA_KEY];
  const parsed = createStoredReadSchema(SessionPendingQueueHoldV1Schema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isSessionPendingQueueHoldBlockingPendingDrain(
  metadata: unknown,
  liveHoldIds: readonly string[] | null = null,
): boolean {
  // Admission on the socket is authoritative, including while the acquire's
  // metadata publication is still in flight to another device.
  if (liveHoldIds !== null) return liveHoldIds.length > 0;
  const holdState = readSessionPendingQueueHoldV1FromMetadata(metadata);
  if (!holdState) return false;
  // A retained acquire is not liveness. Until the existing socket's first
  // observation arrives, only queues that actually contain a hold wait.
  return Object.keys(holdState.holdsById).length > 0;
}

export function writeSessionPendingQueueHoldV1ToMetadata(
  metadata: unknown,
  input: WriteSessionPendingQueueHoldV1Input,
): Record<string, unknown> {
  const base = toMetadataRecord(metadata);
  const existing = readSessionPendingQueueHoldV1FromMetadata(metadata);
  const holdId = input.holdId.trim();
  const localId = readPendingLocalId(input.localId);
  if (!holdId || localId === null) return base;
  const updatedAtMs = normalizeTimestampMs(input.updatedAtMs);
  const expiresAtMs = Math.min(
    normalizeTimestampMs(input.expiresAtMs),
    updatedAtMs + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS,
  );
  const retainedHoldsById = existing?.holdsById ?? {};

  base[SESSION_PENDING_QUEUE_HOLD_METADATA_KEY] = {
    v: 1,
    holdsById: {
      ...retainedHoldsById,
      [holdId]: {
        v: 1,
        holdId,
        kind: 'pending_message_edit',
        localId,
        updatedAtMs,
        expiresAtMs,
      },
    },
  } satisfies SessionPendingQueueHoldV1;
  return base;
}

export function removeSessionPendingQueueHoldV1FromMetadata(
  metadata: unknown,
  holdId: string,
): Record<string, unknown> {
  const base = toMetadataRecord(metadata);
  const existing = readSessionPendingQueueHoldV1FromMetadata(metadata);
  const normalizedHoldId = holdId.trim();
  if (!existing || !normalizedHoldId) return base;

  const nextHolds = { ...existing.holdsById };
  delete nextHolds[normalizedHoldId];

  if (Object.keys(nextHolds).length === 0) {
    delete base[SESSION_PENDING_QUEUE_HOLD_METADATA_KEY];
  } else {
    base[SESSION_PENDING_QUEUE_HOLD_METADATA_KEY] = {
      v: 1,
      holdsById: nextHolds,
    } satisfies SessionPendingQueueHoldV1;
  }

  return base;
}
