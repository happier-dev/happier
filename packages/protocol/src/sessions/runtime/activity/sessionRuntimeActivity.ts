import { z } from 'zod';

export const SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX = 2_147_483_647;

export const SessionRuntimeActivityStateSchema = z.enum([
  'active',
  'idle',
  'unknown',
]);
export type SessionRuntimeActivityState = z.infer<typeof SessionRuntimeActivityStateSchema>;

const SessionRuntimeActivityTupleSchema = z.object({
  state: SessionRuntimeActivityStateSchema,
  activeCount: z.number().int().nonnegative().max(SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX),
}).strict().superRefine((value, context) => {
  const activeShape = value.activeCount > 0;
  const inactiveShape = value.activeCount === 0;
  if ((value.state === 'active' && !activeShape) || (value.state !== 'active' && !inactiveShape)) {
    context.addIssue({
      code: 'custom',
      message: 'Runtime Activity state and active count disagree',
    });
  }
});

export const SessionRuntimeActivitySnapshotSchema = SessionRuntimeActivityTupleSchema;
export type SessionRuntimeActivitySnapshot = z.infer<typeof SessionRuntimeActivitySnapshotSchema>;

export const SessionRuntimeActivityProjectionSchema = z.object({
  state: SessionRuntimeActivityStateSchema,
  activeCount: z.number().int().nonnegative().max(SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX),
  observedAt: z.number().int().nonnegative().safe().nullable(),
  revision: z.number().int().nonnegative().safe(),
}).strict().superRefine((value, context) => {
  const activeShape = value.activeCount > 0;
  const inactiveShape = value.activeCount === 0;
  if ((value.state === 'active' && !activeShape) || (value.state !== 'active' && !inactiveShape)) {
    context.addIssue({
      code: 'custom',
      message: 'Runtime Activity state and active count disagree',
    });
  }
  if (value.revision === 0) {
    if (value.state !== 'unknown' || value.activeCount !== 0 || value.observedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Revision zero is reserved for the exact unknown baseline',
      });
    }
    return;
  }
  if (value.observedAt === null && value.state !== 'unknown') {
    context.addIssue({
      code: 'custom',
      message: 'Only the unknown migration sentinel may omit observedAt at a positive revision',
    });
  }
});
export type SessionRuntimeActivityProjection = z.infer<typeof SessionRuntimeActivityProjectionSchema>;

export const SESSION_RUNTIME_ACTIVITY_PROJECTION_FIELD_NAMES = [
  'runtimeActivityState',
  'runtimeActivityActiveCount',
  'runtimeActivityObservedAt',
  'runtimeActivityRevision',
] as const;

export type SessionRuntimeActivityProjectionFieldsParseResult =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'valid'; projection: SessionRuntimeActivityProjection }>;

export function parseSessionRuntimeActivityProjectionFields(
  value: unknown,
): SessionRuntimeActivityProjectionFieldsParseResult {
  if (!value || typeof value !== 'object') return { kind: 'absent' };
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.prototype.hasOwnProperty.call(record, 'runtimeActivitySourceClass')) return { kind: 'invalid' };
  const presentFields = SESSION_RUNTIME_ACTIVITY_PROJECTION_FIELD_NAMES.filter((field) => (
    Object.prototype.hasOwnProperty.call(record, field) && record[field] !== undefined
  ));
  if (presentFields.length === 0) return { kind: 'absent' };
  if (presentFields.length !== SESSION_RUNTIME_ACTIVITY_PROJECTION_FIELD_NAMES.length) {
    return { kind: 'invalid' };
  }
  const parsed = SessionRuntimeActivityProjectionSchema.safeParse({
    state: record.runtimeActivityState,
    activeCount: record.runtimeActivityActiveCount,
    observedAt: record.runtimeActivityObservedAt,
    revision: record.runtimeActivityRevision,
  });
  return parsed.success ? { kind: 'valid', projection: parsed.data } : { kind: 'invalid' };
}

export type SessionRuntimeActivityProjectionMergeResult =
  | Readonly<{ decision: 'replace'; projection: SessionRuntimeActivityProjection }>
  | Readonly<{
      decision: 'ignore_stale' | 'ignore_identical' | 'resync_conflict' | 'reject_invalid';
      projection: SessionRuntimeActivityProjection;
    }>;

export function mergeSessionRuntimeActivityProjection(
  current: SessionRuntimeActivityProjection,
  incoming: unknown,
): SessionRuntimeActivityProjectionMergeResult {
  const parsed = SessionRuntimeActivityProjectionSchema.safeParse(incoming);
  if (!parsed.success) return { decision: 'reject_invalid', projection: current };
  if (parsed.data.revision > current.revision) return { decision: 'replace', projection: parsed.data };
  if (parsed.data.revision < current.revision) return { decision: 'ignore_stale', projection: current };
  const identical = current.state === parsed.data.state
    && current.activeCount === parsed.data.activeCount
    && current.observedAt === parsed.data.observedAt;
  return identical
    ? { decision: 'ignore_identical', projection: current }
    : { decision: 'resync_conflict', projection: current };
}

export type SessionRuntimeActivityProjectionForPendingDrain = Readonly<{
  runtimeActivityState?: unknown;
  runtimeActivityActiveCount?: unknown;
  runtimeActivityObservedAt?: unknown;
  runtimeActivityRevision?: unknown;
}>;

export type RuntimeIdleAdmission =
  | Readonly<{ decision: 'allow'; revision: number }>
  | Readonly<{ decision: 'defer'; reason: 'active' | 'unknown'; revision: number }>;

export function decideRuntimeIdleAdmission(
  projection: SessionRuntimeActivityProjection,
): RuntimeIdleAdmission {
  return projection.state === 'idle'
    ? { decision: 'allow', revision: projection.revision }
    : { decision: 'defer', reason: projection.state, revision: projection.revision };
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

export function readSessionRuntimeActivityProjectionForPendingDrain(
  activity: SessionRuntimeActivityProjectionForPendingDrain | null | undefined,
): SessionRuntimeActivityProjection | null {
  const observedAt = activity?.runtimeActivityObservedAt === null
    ? null
    : readNonNegativeSafeInteger(activity?.runtimeActivityObservedAt);
  const revision = readNonNegativeSafeInteger(activity?.runtimeActivityRevision);
  if (revision === null || (activity?.runtimeActivityObservedAt !== null && observedAt === null)) return null;
  const parsed = SessionRuntimeActivityProjectionSchema.safeParse({
    state: activity?.runtimeActivityState,
    activeCount: activity?.runtimeActivityActiveCount,
    observedAt,
    revision,
  });
  return parsed.success ? parsed.data : null;
}

export function isSessionRuntimeActivityProjectionIdleForPendingDrain(
  activity: SessionRuntimeActivityProjectionForPendingDrain | null | undefined,
): boolean {
  const projection = readSessionRuntimeActivityProjectionForPendingDrain(activity);
  return projection !== null && decideRuntimeIdleAdmission(projection).decision === 'allow';
}
