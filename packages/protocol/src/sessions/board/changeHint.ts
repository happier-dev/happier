import { z } from 'zod/mini';
import { ExecutionRunIdSchema, SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionSystemRecordAddressSchema } from '../system/records/sessionSystemRecordAddress.js';

/** A missing address revalidates the Session's records and access. No content travels here. */
export const SessionSystemRecordInvalidationV1Schema = z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  address: z.optional(SessionSystemRecordAddressSchema),
});
export type SessionSystemRecordInvalidationV1 = z.infer<typeof SessionSystemRecordInvalidationV1Schema>;


/** Content-free wake hint; ordinary Session changes also invalidate surface reads. */
export const SessionSurfacesChangeHintV1Schema = z.strictObject({
  v: z.literal(1),
  sessionSurfaces: z.literal(true),
});
export type SessionSurfacesChangeHintV1 = z.infer<typeof SessionSurfacesChangeHintV1Schema>;

export const SessionSystemRecordChangeHintV1Schema = z.strictObject({
  v: z.literal(1),
  sessionRecords: z.strictObject({ sessionId: asProtocolZod(SessionIdSchema), address: SessionSystemRecordAddressSchema }),
});
const SESSION_RECORD_CHANGE_PREFIX = 'session-record:';

/** One retained feed entity per physical record, independent of transcript coalescing. */
export function buildSessionSystemRecordChangeV1(recordId: string, target: Required<SessionSystemRecordInvalidationV1>) {
  return { kind: 'account' as const, entityId: `${SESSION_RECORD_CHANGE_PREFIX}${recordId}`,
    hint: SessionSystemRecordChangeHintV1Schema.parse({ v: 1, sessionRecords: target }) };
}

export function isSessionSystemRecordChangeEntityV1(change: Readonly<{ kind: string; entityId: string }>) {
  return change.kind === 'account' && change.entityId.startsWith(SESSION_RECORD_CHANGE_PREFIX);
}

export function readSessionSystemRecordChangeV1(change: Readonly<{ kind: string; entityId: string; hint?: unknown }>) {
  if (!isSessionSystemRecordChangeEntityV1(change) || change.entityId === SESSION_RECORD_CHANGE_PREFIX) return null;
  const hint = SessionSystemRecordChangeHintV1Schema.safeParse(change.hint);
  return hint.success ? hint.data.sessionRecords : null;
}

const sequence = z.number().check(z.int(), z.minimum(0));
// Publication and HTTP projection enrich known row facts without changing physical records.
const rowHintFacts = {
  pendingExecutionRunIds: z.optional(z.array(ExecutionRunIdSchema)),
  followSourceChanged: z.optional(z.literal(false)),
  followSourceUnchangedSinceCursor: z.optional(sequence),
  usageAccountingChanged: z.optional(z.literal(false)),
  usageAccountingUnchangedSinceCursor: z.optional(sequence),
  memoryInputsChanged: z.optional(z.literal(false)),
  memoryInputsUnchangedSinceCursor: z.optional(sequence),
  followReceiverAvailabilityChanged: z.optional(z.boolean()),
  followReceiverAvailabilityChangedAtCursor: z.optional(sequence),
};
const SessionRowOnlyHintSchema = z.union([
  z.strictObject({ lastMessageSeq: sequence, lastMessageId: z.optional(z.string()), ...rowHintFacts }),
  z.strictObject({ updatedMessageSeq: sequence, updatedMessageId: z.optional(z.string()), ...rowHintFacts }),
  z.strictObject({ sharedMetadataVersion: sequence, ...rowHintFacts }),
  z.strictObject({ lastViewedSessionSeq: sequence, ...rowHintFacts }),
  z.strictObject({ metadataVersion: sequence, agentStateVersion: z.optional(sequence), ...rowHintFacts }),
  z.strictObject({ agentStateVersion: sequence, ...rowHintFacts }),
  z.strictObject({ runtimeActivityRevision: sequence, ...rowHintFacts }),
  z.strictObject({ latestTurnStatusObservedAt: sequence, ...rowHintFacts }),
  z.strictObject({ latestReadyEventSeq: sequence, latestReadyEventAt: sequence, ...rowHintFacts }),
]);

/** Every key a known row-only hint may carry, derived from the schema above (its single owner). */
export const SESSION_ROW_ONLY_HINT_KEYS: ReadonlySet<string> = new Set(
  SessionRowOnlyHintSchema.def.options.flatMap((option) => Object.keys(option.def.shape)),
);

/** Unknown and legacy hints remain conservative; only known row facts exclude record changes. */
export function isSessionSystemRecordUnchangedHintV1(hint: unknown) {
  return SessionRowOnlyHintSchema.safeParse(hint).success;
}
