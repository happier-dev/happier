import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

const Timestamp = z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));
const CeilingBytes = z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER));
/** One native observation, paired with the ceiling that was actually applied. */
export const SessionGuardMemoryObservationV1Schema = lazyZodSchema(() => z.strictObject({
  usedBytes: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)), limitBytes: CeilingBytes,
}));
export type SessionGuardMemoryObservationV1 = z.infer<typeof SessionGuardMemoryObservationV1Schema>;
const WarningRule = z.enum(['idle_sessions', 'memory_guard']);
const StopRule = z.enum(['idle_sessions', 'memory_guard', 'ceiling']);
const stopping = { kind: z.literal('stopping'), stopAt: Timestamp, rule: WarningRule };
const stopped = { kind: z.literal('stopped'), at: Timestamp, rule: StopRule,
  idleMs: z.optional(Timestamp), freedBytes: z.optional(Timestamp) };

/** Content-free presentation, carried by the Session's canonical shared metadata. */
export const SessionGuardStateV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ v: z.literal(1), ...stopping, ceilingBytes: z.optional(z.nullable(CeilingBytes)) }),
  z.strictObject({ v: z.literal(1), ...stopped, ceilingBytes: z.optional(z.nullable(CeilingBytes)) }),
  z.strictObject({ v: z.literal(1), ...stopped, kind: z.literal('requested'), ceilingBytes: z.optional(z.nullable(CeilingBytes)) }),
  z.strictObject({ v: z.literal(1), kind: z.literal('configured'), ceilingBytes: z.nullable(CeilingBytes) }),
]));
export type SessionGuardStateV1 = z.infer<typeof SessionGuardStateV1Schema>;
export const SessionGuardStateV1StoredSchema = createStoredReadSchema(SessionGuardStateV1Schema);

/** Undefined inherits Machine policy; null is the Session's explicit no-ceiling choice. */
export function readSessionMemoryCeilingOverride(metadata: unknown): number | null | undefined {
  if (!metadata || typeof metadata !== 'object' || !('sessionGuardStateV1' in metadata)) return undefined;
  if (metadata.sessionGuardStateV1 === undefined) return undefined;
  return SessionGuardStateV1StoredSchema.parse(metadata.sessionGuardStateV1).ceilingBytes;
}

/** Shared by the live publisher and the authenticated inactive-Session metadata CAS. */
export function applySessionMemoryCeilingOverrideToMetadata<T extends Record<string, unknown>>(
  metadata: T, bytes: number | null,
): T & { sessionGuardStateV1: SessionGuardStateV1 } {
  const ceilingBytes = z.nullable(CeilingBytes).parse(bytes);
  const previous = metadata.sessionGuardStateV1;
  const presentation = previous === undefined ? undefined : SessionGuardStateV1StoredSchema.parse(previous);
  const sessionGuardStateV1: SessionGuardStateV1 = presentation
    ? { ...(previous && typeof previous === 'object' ? previous : {}), ...presentation, ceilingBytes }
    : { v: 1, kind: 'configured', ceilingBytes };
  return { ...metadata, sessionGuardStateV1 };
}

export const SessionGuardNoticeStateV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject(stopping),
  z.strictObject({ ...stopped, ceilingBytes: z.optional(CeilingBytes) }),
  z.strictObject({ kind: z.literal('clear') }),
  z.strictObject({ kind: z.literal('ceiling'), bytes: z.nullable(CeilingBytes) }),
  z.strictObject({ kind: z.literal('notify_ceiling'), notice: z.enum(['ceiling_near', 'ceiling_reached']),
    memory: z.optional(SessionGuardMemoryObservationV1Schema) }),
  z.strictObject({ kind: z.literal('notify_terminal_warning'), terminalId: z.string().check(z.minLength(1)),
    terminalKey: z.string().check(z.minLength(1), z.maxLength(2000)), stopAt: Timestamp, idleMs: z.optional(Timestamp) }),
]));
export type SessionGuardNoticeStateV1 = z.infer<typeof SessionGuardNoticeStateV1Schema>;

export const SessionGuardNoticeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)), state: SessionGuardNoticeStateV1Schema,
}));
export type SessionGuardNoticeRequestV1 = z.infer<typeof SessionGuardNoticeRequestV1Schema>;
export const SessionGuardNoticeResponseV1Schema = lazyZodSchema(() => z.strictObject({ ok: z.boolean() }));

export const SessionStopRecordV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), at: Timestamp, rule: StopRule, idleMs: z.optional(Timestamp), freedBytes: z.optional(Timestamp),
  ceilingBytes: z.optional(CeilingBytes),
  status: z.enum(['requested', 'stopped', 'cancelled', 'failed']),
  settledAt: z.optional(Timestamp),
}));
export type SessionStopRecordV1 = z.infer<typeof SessionStopRecordV1Schema>;
export const SessionStopRecordV1StoredSchema = createStoredReadSchema(SessionStopRecordV1Schema);

/** Immutable transcript intent never claims exit; the current system record owns settlement. */
export function buildSessionStopTranscriptEventV1(record: SessionStopRecordV1): Readonly<{
  type: 'message'; message: string; sessionStopV1: SessionStopRecordV1;
}> {
  const sessionStopV1 = SessionStopRecordV1Schema.parse(record);
  if (sessionStopV1.status !== 'requested') throw new Error('Session stop transcript events require requested intent');
  return { type: 'message', message: 'Happier requested this session to stop. Resume it after it stops to continue.', sessionStopV1 };
}

export function readSessionStopTranscriptRecordV1(event: unknown): SessionStopRecordV1 | null {
  if (!event || typeof event !== 'object' || !('type' in event) || event.type !== 'message'
    || !('sessionStopV1' in event)) return null;
  const parsed = SessionStopRecordV1StoredSchema.safeParse(event.sessionStopV1);
  return parsed.success && parsed.data.status === 'requested' ? parsed.data : null;
}
