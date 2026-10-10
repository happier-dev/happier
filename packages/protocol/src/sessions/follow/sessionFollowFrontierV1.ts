import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { isProjectedSessionStalledV1 } from '../awareness/runtime.js';

/**
 * Canonical Session Follow frontier.
 *
 * The frontier is the exact tuple of already existing canonical source Session
 * components that one Follow observer has consumed. It is deliberately not a
 * Follow-specific generation, event log, or semantic state: every component is
 * projected from facts the Session owners already maintain.
 *
 * Wall-clock facts such as `latestTurnStatusObservedAt` stay presentation and
 * freshness signals; they are never delivery cursors, so they are absent here.
 */

export const SESSION_FOLLOW_DELIVERED_TURN_STATUSES_V1 = ['completed', 'failed', 'cancelled'] as const;
export type SessionFollowDeliveredTurnStatusV1 = (typeof SESSION_FOLLOW_DELIVERED_TURN_STATUSES_V1)[number];
export const SessionFollowDeliveredTurnStatusV1Schema = lazyZodSchema(() => z.enum(SESSION_FOLLOW_DELIVERED_TURN_STATUSES_V1));

export const SessionFollowTerminalTurnV1Schema = lazyZodSchema(() => z
  .object({
    id: TurnIdSchema,
    status: SessionFollowDeliveredTurnStatusV1Schema,
  })
  .strict());
export type SessionFollowTerminalTurnV1 = z.infer<typeof SessionFollowTerminalTurnV1Schema>;

/** A deliverable own-turn fact, including presence loss before terminal completion. */
export const SessionFollowObservedTurnV1Schema = lazyZodSchema(() => SessionFollowTerminalTurnV1Schema.extend({
  status: z.enum([...SESSION_FOLLOW_DELIVERED_TURN_STATUSES_V1, 'stalled']),
}));
export type SessionFollowObservedTurnV1 = z.infer<typeof SessionFollowObservedTurnV1Schema>;

const FrontierSequenceSchema = lazyZodSchema(() => z.number().int().min(0));

export const SessionFollowFrontierV1Schema = lazyZodSchema(() => z
  .object({
    transcriptSeq: FrontierSequenceSchema,
    readyEventSeq: FrontierSequenceSchema,
    agentStateVersion: FrontierSequenceSchema,
    turn: SessionFollowObservedTurnV1Schema.nullable(),
  })
  .strict());
export type SessionFollowFrontierV1 = z.infer<typeof SessionFollowFrontierV1Schema>;

const PersistedSessionFollowFrontierV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  transcriptSeq: FrontierSequenceSchema,
  readyEventSeq: FrontierSequenceSchema,
  agentStateVersion: FrontierSequenceSchema,
  turn: SessionFollowObservedTurnV1Schema.nullable(),
}).strict());

export function encodePersistedSessionFollowFrontierV1(frontier: SessionFollowFrontierV1): string {
  const value = SessionFollowFrontierV1Schema.parse(frontier);
  return JSON.stringify({ v: 1, ...value });
}

export function parsePersistedSessionFollowFrontierV1(value: string): SessionFollowFrontierV1 | null {
  try {
    const parsed = createStoredReadSchema(PersistedSessionFollowFrontierV1Schema).safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const { v: _version, ...frontier } = parsed.data;
    return frontier;
  } catch {
    return null;
  }
}

export const SESSION_FOLLOW_ZERO_FRONTIER_V1: SessionFollowFrontierV1 = Object.freeze({
  transcriptSeq: 0,
  readyEventSeq: 0,
  agentStateVersion: 0,
  turn: null,
});

export type SessionFollowFrontierInputV1 = Readonly<{
  transcriptSeq: number | null | undefined;
  readyEventSeq: number | null | undefined;
  agentStateVersion: number | null | undefined;
  turn: Readonly<{ id: string | null | undefined; status: string | null | undefined }> | null | undefined;
}>;

function normalizeSequence(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function isDeliveredTurnStatus(value: unknown): value is SessionFollowDeliveredTurnStatusV1 {
  return typeof value === 'string'
    && (SESSION_FOLLOW_DELIVERED_TURN_STATUSES_V1 as readonly string[]).includes(value);
}

/**
 * Projects any nullable component mix onto the one logical frontier. A missing
 * ready-event sequence is logically identical to `0` (pre-ready), and a turn is
 * only carried when both its identity and a deliverable own-turn status are present.
 */
export function normalizeSessionFollowFrontierV1(input: SessionFollowFrontierInputV1): SessionFollowFrontierV1 {
  const turn = input.turn ?? null;
  const turnId = typeof turn?.id === 'string' && turn.id.length > 0 ? turn.id : null;
  const turnStatus = turn?.status === 'stalled' || isDeliveredTurnStatus(turn?.status) ? turn.status : null;
  return {
    transcriptSeq: normalizeSequence(input.transcriptSeq),
    readyEventSeq: normalizeSequence(input.readyEventSeq),
    agentStateVersion: normalizeSequence(input.agentStateVersion),
    turn: turnId !== null && turnStatus !== null ? { id: turnId, status: turnStatus } : null,
  };
}

export type SessionFollowSourceFrontierFactsV1 = Readonly<{
  seq: number | null | undefined;
  latestReadyEventSeq: number | null | undefined;
  agentStateVersion: number | null | undefined;
  latestTurnId: string | null | undefined;
  latestTurnStatus: string | null | undefined;
  /** Supplied only by the reports-to presence observation, never by ordinary Follow. */
  active?: boolean | null;
}>;

/**
 * Projects the current frontier from the canonical source Session row. A
 * reachable non-terminal latest turn yields `null`; an inactive in-flight own
 * turn carries the exact stalled identity through the same delivery/ACK path.
 */
export function projectSessionFollowFrontierFromSourceV1(
  source: SessionFollowSourceFrontierFactsV1,
): SessionFollowFrontierV1 {
  return normalizeSessionFollowFrontierV1({
    transcriptSeq: source.seq,
    readyEventSeq: source.latestReadyEventSeq,
    agentStateVersion: source.agentStateVersion,
    turn: { id: source.latestTurnId,
      status: isProjectedSessionStalledV1(source) ? 'stalled' : source.latestTurnStatus },
  });
}

export function isSessionFollowTurnEqualV1(
  left: SessionFollowObservedTurnV1 | null,
  right: SessionFollowObservedTurnV1 | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.id === right.id && left.status === right.status;
}

export function isSessionFollowFrontierEqualV1(
  left: SessionFollowFrontierV1,
  right: SessionFollowFrontierV1,
): boolean {
  return left.transcriptSeq === right.transcriptSeq
    && left.readyEventSeq === right.readyEventSeq
    && left.agentStateVersion === right.agentStateVersion
    && isSessionFollowTurnEqualV1(left.turn, right.turn);
}

export type SessionFollowFrontierProgressV1 = 'equal' | 'ahead' | 'behind';

/**
 * Compares `candidate` against an already delivered `delivered` frontier.
 *
 * Numeric components are monotone. Deliverable turns are not ordered: a different
 * exact `(id, status)` is progress, never a comparison, so turn identity is
 * never sorted lexically or by timestamp.
 */
export function compareSessionFollowFrontierProgressV1(
  delivered: SessionFollowFrontierV1,
  candidate: SessionFollowFrontierV1,
): SessionFollowFrontierProgressV1 {
  if (
    candidate.transcriptSeq < delivered.transcriptSeq
    || candidate.readyEventSeq < delivered.readyEventSeq
    || candidate.agentStateVersion < delivered.agentStateVersion
  ) {
    return 'behind';
  }
  return isSessionFollowFrontierEqualV1(delivered, candidate) ? 'equal' : 'ahead';
}

/**
 * Checks one ACK against the stored lower bound, the exact observe response
 * that produced the delivery, and the source frontier visible at ACK time.
 * Deliverable turns are identities rather than ordered counters, so consumption
 * must name the observed turn exactly; the server separately requires it to
 * remain the current deliverable turn before advancing persistence.
 */
export function isSessionFollowConsumptionWithinCurrentV1(input: Readonly<{
  expected: SessionFollowFrontierV1;
  observed: SessionFollowFrontierV1;
  consumed: SessionFollowFrontierV1;
  current: SessionFollowFrontierV1;
}>): boolean {
  const { expected, observed, consumed, current } = input;
  return consumed.transcriptSeq >= expected.transcriptSeq
    && consumed.readyEventSeq >= expected.readyEventSeq
    && consumed.agentStateVersion >= expected.agentStateVersion
    && consumed.transcriptSeq <= observed.transcriptSeq
    && consumed.readyEventSeq <= observed.readyEventSeq
    && consumed.agentStateVersion <= observed.agentStateVersion
    && isSessionFollowTurnEqualV1(consumed.turn, observed.turn)
    && consumed.transcriptSeq <= current.transcriptSeq
    && consumed.readyEventSeq <= current.readyEventSeq
    && consumed.agentStateVersion <= current.agentStateVersion;
}
