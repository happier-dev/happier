import { z } from 'zod';

export const SessionWorkStateStatusV1Schema = z.enum([
  'pending',
  'active',
  'paused',
  'blocked',
  'complete',
  'cancelled',
  'unknown',
]);
export type SessionWorkStateStatusV1 = z.infer<typeof SessionWorkStateStatusV1Schema>;

export const SessionWorkStateStatusReasonV1Schema = z.enum(['budgetLimited', 'interrupted']);
export type SessionWorkStateStatusReasonV1 = z.infer<typeof SessionWorkStateStatusReasonV1Schema>;

export const SessionWorkStateItemKindV1Schema = z.enum(['goal', 'task', 'todo']);
export type SessionWorkStateItemKindV1 = z.infer<typeof SessionWorkStateItemKindV1Schema>;

export const SessionWorkStateItemOriginV1Schema = z.enum(['vendor', 'happier', 'derived']);
export type SessionWorkStateItemOriginV1 = z.infer<typeof SessionWorkStateItemOriginV1Schema>;

// Provider-derived goal capabilities. The owning provider computes these from its own signals
// (Codex from app-server goal mode; Claude from observed `goal_status` + native `/goal` support) so
// generic UI gating stays capability-driven instead of branching on provider id. All members
// optional + passthrough so the projection is additive and forward-compatible.
export const SessionWorkStateGoalCapabilitiesV1Schema = z
  .object({
    canEdit: z.boolean().optional(),
    canStop: z.boolean().optional(),
    canClear: z.boolean().optional(),
  })
  .passthrough();
export type SessionWorkStateGoalCapabilitiesV1 = z.infer<typeof SessionWorkStateGoalCapabilitiesV1Schema>;

export const SessionWorkStateItemV1Schema = z
  .object({
    id: z.string().min(1),
    kind: SessionWorkStateItemKindV1Schema,
    origin: SessionWorkStateItemOriginV1Schema,
    status: SessionWorkStateStatusV1Schema,
    title: z.string().trim().min(1).max(4000),
    summary: z.string().trim().max(8000).optional(),
    backendId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    vendorRef: z.string().min(1).optional(),
    order: z.number().int().nonnegative().optional(),
    parentId: z.string().min(1).optional(),
    priority: z.string().optional(),
    progress: z.number().finite().min(0).max(1).optional(),
    statusReason: SessionWorkStateStatusReasonV1Schema.optional(),
    goalCapabilities: SessionWorkStateGoalCapabilitiesV1Schema.optional(),
    tokenBudget: z.number().finite().positive().nullable().optional(),
    tokensUsed: z.number().int().nonnegative().optional(),
    timeUsedSeconds: z.number().finite().nonnegative().optional(),
    createdAt: z.number().int().nonnegative().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    completedAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .passthrough();
export type SessionWorkStateItemV1 = z.infer<typeof SessionWorkStateItemV1Schema>;

export const SessionWorkStateTruncationV1Schema = z
  .object({
    reason: z.enum(['item_limit', 'provider_limit']),
    omittedCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type SessionWorkStateTruncationV1 = z.infer<typeof SessionWorkStateTruncationV1Schema>;

export const SessionWorkStateV1Schema = z
  .object({
    v: z.literal(1),
    backendId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    updatedAt: z.number().int().nonnegative(),
    items: z.array(SessionWorkStateItemV1Schema),
    primaryItemId: z.string().min(1).nullable().optional(),
    truncated: SessionWorkStateTruncationV1Schema.optional(),
  })
  .passthrough();
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
