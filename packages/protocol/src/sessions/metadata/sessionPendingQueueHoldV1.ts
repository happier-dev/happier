import { z } from 'zod';
import { PendingLocalIdSchema, readPendingLocalId } from '../pending/pendingLocalId.js';

export const SESSION_PENDING_QUEUE_HOLD_METADATA_KEY = 'sessionPendingQueueHoldV1' as const;
export const SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS = 5 * 60_000;

export const SessionPendingQueueHoldEntryV1Schema = z
  .object({
    v: z.literal(1),
    holdId: z.string().trim().min(1),
    kind: z.literal('pending_message_edit'),
    localId: PendingLocalIdSchema,
    updatedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type SessionPendingQueueHoldEntryV1 = z.infer<typeof SessionPendingQueueHoldEntryV1Schema>;

export const SessionPendingQueueHoldV1Schema = z
  .object({
    v: z.literal(1),
    holdsById: z.record(z.string().trim().min(1), SessionPendingQueueHoldEntryV1Schema),
  })
  .strict();
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

function isHoldWithinProtocolTtl(hold: SessionPendingQueueHoldEntryV1): boolean {
  return hold.expiresAtMs >= hold.updatedAtMs
    && hold.expiresAtMs - hold.updatedAtMs <= SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS;
}

function isHoldActiveAt(hold: SessionPendingQueueHoldEntryV1, nowMs: number): boolean {
  return hold.expiresAtMs > nowMs
    && hold.expiresAtMs <= nowMs + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS
    && isHoldWithinProtocolTtl(hold);
}

function pruneInactiveHolds(
  holdsById: Readonly<Record<string, SessionPendingQueueHoldEntryV1>>,
  nowMs: number,
): Record<string, SessionPendingQueueHoldEntryV1> {
  return Object.fromEntries(
    Object.entries(holdsById).filter(([, hold]) => isHoldActiveAt(hold, nowMs)),
  );
}

export function readSessionPendingQueueHoldV1FromMetadata(metadata: unknown): SessionPendingQueueHoldV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Record<string, unknown>)[SESSION_PENDING_QUEUE_HOLD_METADATA_KEY];
  const parsed = SessionPendingQueueHoldV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isSessionPendingQueueHoldBlockingPendingDrain(metadata: unknown, nowMs: number = Date.now()): boolean {
  const holdState = readSessionPendingQueueHoldV1FromMetadata(metadata);
  if (!holdState) return false;
  const now = normalizeTimestampMs(nowMs);
  return Object.values(holdState.holdsById).some((hold) => isHoldActiveAt(hold, now));
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
  const retainedHoldsById = existing
    ? pruneInactiveHolds(existing.holdsById, updatedAtMs)
    : {};

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

  const nextHolds = pruneInactiveHolds(existing.holdsById, normalizeTimestampMs(Date.now()));
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
