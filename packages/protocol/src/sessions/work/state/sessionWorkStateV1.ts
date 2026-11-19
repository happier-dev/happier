import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SessionWorkStateStatusV1Schema = lazyZodSchema(() => z.enum([
  'pending',
  'active',
  'paused',
  'blocked',
  'complete',
  'cancelled',
  'unknown',
]));
export type SessionWorkStateStatusV1 = z.infer<typeof SessionWorkStateStatusV1Schema>;

export const SessionWorkStateStatusReasonV1Schema = lazyZodSchema(() => z.enum([
  'blocked',
  'usageLimited',
  'budgetLimited',
  'interrupted',
]));
export type SessionWorkStateStatusReasonV1 = z.infer<typeof SessionWorkStateStatusReasonV1Schema>;

export const SessionWorkStateItemKindV1Schema = lazyZodSchema(() => z.enum(['goal', 'task', 'todo']));
export type SessionWorkStateItemKindV1 = z.infer<typeof SessionWorkStateItemKindV1Schema>;

export const SessionWorkStateItemOriginV1Schema = lazyZodSchema(() => z.enum(['vendor', 'happier', 'derived']));
export type SessionWorkStateItemOriginV1 = z.infer<typeof SessionWorkStateItemOriginV1Schema>;

// Provider-derived goal capabilities. The owning provider computes these from its own signals
// (Codex from app-server goal mode; Claude from observed `goal_status` + native `/goal` support) so
// generic UI gating stays capability-driven instead of branching on provider id. All members
// optional + passthrough so the projection is additive and forward-compatible.
export const SessionWorkStateGoalCapabilitiesV1Schema = lazyZodSchema(() => z.looseObject({
    canEdit: z.optional(z.boolean()),
    canStop: z.optional(z.boolean()),
    canClear: z.optional(z.boolean()),
  }));
export type SessionWorkStateGoalCapabilitiesV1 = z.infer<typeof SessionWorkStateGoalCapabilitiesV1Schema>;

export const SessionWorkStateItemV1Schema = lazyZodSchema(() => z.looseObject({
    id: z.string().check(z.minLength(1)),
    kind: SessionWorkStateItemKindV1Schema,
    origin: SessionWorkStateItemOriginV1Schema,
    status: SessionWorkStateStatusV1Schema,
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(4000)),
    summary: z.optional(z.string().check(z.trim(), z.maxLength(8000))),
    backendId: z.optional(z.string().check(z.minLength(1))),
    agentId: z.optional(z.string().check(z.minLength(1))),
    vendorRef: z.optional(z.string().check(z.minLength(1))),
    order: z.optional(z.number().check(z.int(), z.nonnegative())),
    parentId: z.optional(z.string().check(z.minLength(1))),
    priority: z.optional(z.string()),
    progress: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
    statusReason: z.optional(SessionWorkStateStatusReasonV1Schema),
    goalCapabilities: z.optional(SessionWorkStateGoalCapabilitiesV1Schema),
    tokenBudget: z.optional(z.nullable(z.number().check(z.positive()))),
    tokensUsed: z.optional(z.number().check(z.int(), z.nonnegative())),
    timeUsedSeconds: z.optional(z.number().check(z.nonnegative())),
    createdAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    startedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    completedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionWorkStateItemV1 = z.infer<typeof SessionWorkStateItemV1Schema>;

/** Replace the Happier checklist in the Session bound to the tool. */
export const SessionTasksSetInputV1Schema = lazyZodSchema(() => z.strictObject({
    items: z.array(z.strictObject(z.pick(SessionWorkStateItemV1Schema, { title: true, status: true }).shape)),
}));
export type SessionTasksSetInputV1 = z.infer<typeof SessionTasksSetInputV1Schema>;

export const SessionWorkStateTruncationV1Schema = lazyZodSchema(() => z.looseObject({
    reason: z.enum(['item_limit', 'provider_limit']),
    omittedCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  }));
export type SessionWorkStateTruncationV1 = z.infer<typeof SessionWorkStateTruncationV1Schema>;

export const SessionWorkStateV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    backendId: z.string().check(z.minLength(1)),
    agentId: z.optional(z.string().check(z.minLength(1))),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    items: z.array(SessionWorkStateItemV1Schema),
    primaryItemId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    truncated: z.optional(SessionWorkStateTruncationV1Schema),
  }));
export type SessionWorkStateV1 = z.infer<typeof SessionWorkStateV1Schema>;

export type SessionWorkStateUnknownItemV1 = Readonly<Record<string, unknown>>;
export type SessionWorkStateWriteItemV1 = SessionWorkStateItemV1 | SessionWorkStateUnknownItemV1;
export type SessionWorkStateWriteSnapshotV1 = Omit<SessionWorkStateV1, 'items'> &
  Readonly<{ items: readonly SessionWorkStateWriteItemV1[] }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readPrimaryItemId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readNonEmptyString(value) ?? undefined;
}

export function readDisplayableSessionWorkStateV1(value: unknown): SessionWorkStateV1 | null {
  const record = asRecord(value);
  if (!record || record.v !== 1) return null;

  const backendId = readNonEmptyString(record.backendId);
  const updatedAt = readNonNegativeInteger(record.updatedAt);
  if (!backendId || updatedAt === null || !Array.isArray(record.items)) return null;

  const displayableItems = record.items.flatMap((item): SessionWorkStateItemV1[] => {
    const parsed = SessionWorkStateItemV1Schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  if (record.items.length > 0 && displayableItems.length === 0) return null;

  const agentId = readNonEmptyString(record.agentId);
  const primaryItemId = readPrimaryItemId(record.primaryItemId);
  const truncated = SessionWorkStateTruncationV1Schema.safeParse(record.truncated);
  const {
    agentId: _agentId,
    backendId: _backendId,
    items: _items,
    primaryItemId: _primaryItemId,
    truncated: _truncated,
    updatedAt: _updatedAt,
    v: _v,
    ...passthrough
  } = record;

  return {
    ...passthrough,
    v: 1,
    backendId,
    ...(agentId ? { agentId } : {}),
    updatedAt,
    items: displayableItems,
    ...(primaryItemId !== undefined ? { primaryItemId } : {}),
    ...(truncated.success ? { truncated: truncated.data } : {}),
  };
}

export function readSessionWorkStateV1FromMetadata(metadata: unknown): SessionWorkStateV1 | null {
  return readDisplayableSessionWorkStateV1(asRecord(metadata)?.sessionWorkStateV1);
}

export function writeSessionWorkStateV1ToMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  workState: SessionWorkStateV1 | null,
): TMetadata {
  const next = { ...metadata };
  if (workState === null) {
    delete next.sessionWorkStateV1;
    return next;
  }
  return {
    ...next,
    sessionWorkStateV1: SessionWorkStateV1Schema.parse(workState),
  };
}
