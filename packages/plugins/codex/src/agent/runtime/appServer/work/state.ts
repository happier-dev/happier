import { z } from 'zod';
import {
  mergeSessionWorkStateMetadataV1,
  type SessionWorkStateItemV1,
  type SessionWorkStateStatusV1,
  type SessionWorkStateV1,
  type SessionWorkStateWriteSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

type MetadataRecord = Record<string, unknown>;
type CodexAppServerGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete';

const CODEX_BACKEND_ID = 'codex';
const LEGACY_CODEX_GOAL_ITEM_ID = 'goal:codex:thread';
const LEGACY_CODEX_GOAL_ITEM_PREFIX = 'goal:codex:';

const CodexAppServerGoalSchema = z
  .object({
    threadId: z.string().min(1),
    objective: z.string().trim().min(1).max(4000),
    status: z.enum(['active', 'paused', 'budgetLimited', 'complete']),
    tokenBudget: z.number().finite().positive().nullable().optional(),
    tokensUsed: z.number().int().nonnegative().optional(),
    timeUsedSeconds: z.number().finite().nonnegative().optional(),
    createdAt: z.union([z.string(), z.number()]).optional(),
    updatedAt: z.union([z.string(), z.number()]),
  })
  .passthrough();

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function readItems(value: unknown): MetadataRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeCodexGoalStatus(status: CodexAppServerGoalStatus): SessionWorkStateStatusV1 {
  if (status === 'budgetLimited') return 'blocked';
  if (status === 'complete') return 'complete';
  return status;
}

function normalizeCodexGoalStatusReason(status: CodexAppServerGoalStatus): 'budgetLimited' | undefined {
  return status === 'budgetLimited' ? 'budgetLimited' : undefined;
}

function buildCodexGoalItemId(vendorRef: string): string {
  const normalized = vendorRef.trim();
  if (!normalized) {
    throw new Error('vendorRef is required');
  }
  return `goal:${normalized}`;
}

function normalizeCodexAppServerGoalToSessionWorkStateItem(params: Readonly<{
  backendId: string;
  agentId?: string;
  goal: unknown;
}>): SessionWorkStateItemV1 | null {
  const parsed = CodexAppServerGoalSchema.safeParse(params.goal);
  if (!parsed.success) return null;

  const updatedAt = normalizeTimestampMs(parsed.data.updatedAt);
  if (updatedAt === null) return null;
  const createdAt = normalizeTimestampMs(parsed.data.createdAt);
  const statusReason = normalizeCodexGoalStatusReason(parsed.data.status);

  return {
    id: buildCodexGoalItemId(parsed.data.threadId),
    kind: 'goal',
    origin: 'vendor',
    status: normalizeCodexGoalStatus(parsed.data.status),
    ...(statusReason ? { statusReason } : {}),
    title: parsed.data.objective.trim(),
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    vendorRef: parsed.data.threadId,
    ...(Object.prototype.hasOwnProperty.call(parsed.data, 'tokenBudget') ? { tokenBudget: parsed.data.tokenBudget } : {}),
    ...(typeof parsed.data.tokensUsed === 'number' ? { tokensUsed: parsed.data.tokensUsed } : {}),
    ...(typeof parsed.data.timeUsedSeconds === 'number' ? { timeUsedSeconds: parsed.data.timeUsedSeconds } : {}),
    ...(createdAt !== null ? { createdAt } : {}),
    updatedAt,
  };
}

function readCurrentWorkState(metadata: unknown, backendId: string): MetadataRecord {
  const current = asRecord(asRecord(metadata)?.sessionWorkStateV1) ?? {};
  return {
    ...current,
    v: 1,
    backendId: readString(current.backendId) ?? backendId,
    updatedAt: readNonNegativeInteger(current.updatedAt) ?? 0,
    items: readItems(current.items),
  };
}

function isCodexGoalItem(item: MetadataRecord): boolean {
  const id = readString(item.id);
  if (id === LEGACY_CODEX_GOAL_ITEM_ID) return true;
  if (id?.startsWith(LEGACY_CODEX_GOAL_ITEM_PREFIX)) return true;
  return item.kind === 'goal'
    && item.origin === 'vendor'
    && item.backendId === CODEX_BACKEND_ID;
}

export function mergeCodexGoalIntoSessionWorkStateMetadata<TMetadata extends object>(
  metadata: TMetadata,
  goal: unknown,
  options: Readonly<{
    backendId?: string;
    agentId?: string;
  }> = {},
): TMetadata & { sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 } {
  const backendId = options.backendId ?? CODEX_BACKEND_ID;
  const item = normalizeCodexAppServerGoalToSessionWorkStateItem({
    backendId,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    goal,
  });

  if (!item) {
    return removeCodexGoalFromSessionWorkStateMetadata(metadata, { backendId });
  }

  const current = readCurrentWorkState(metadata, backendId);
  const existingCodexGoalItemIds = readItems(current.items)
    .filter(isCodexGoalItem)
    .map((existingItem) => readString(existingItem.id))
    .filter((id): id is string => Boolean(id));
  const nextOwned: SessionWorkStateV1 = {
    v: 1,
    backendId,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    updatedAt: item.updatedAt,
    items: [item],
    primaryItemId: item.id,
  };
  // The merge chokepoint resolves `primaryItemId` canonically over the MERGED
  // item set (shared `resolveSessionWorkStatePrimaryItemId`), so this path no
  // longer re-derives its own primary — one rule, no Codex-local duplicate.
  return {
    ...metadata,
    ...mergeSessionWorkStateMetadataV1({
      metadata,
      nextOwned,
      ownedItemIds: [...existingCodexGoalItemIds, item.id, LEGACY_CODEX_GOAL_ITEM_ID],
      ownedItemIdPrefixes: [LEGACY_CODEX_GOAL_ITEM_PREFIX],
    }),
  };
}

export function removeCodexGoalFromSessionWorkStateMetadata<TMetadata extends object>(
  metadata: TMetadata,
  options: Readonly<{
    backendId?: string;
  }> = {},
): TMetadata & { sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 } {
  const backendId = options.backendId ?? CODEX_BACKEND_ID;
  const current = readCurrentWorkState(metadata, backendId);
  const ownedItemIds = readItems(current.items)
    .filter(isCodexGoalItem)
    .map((item) => readString(item.id))
    .filter((id): id is string => Boolean(id));

  const nextOwned: SessionWorkStateV1 = {
    v: 1,
    backendId,
    updatedAt: readNonNegativeInteger(current.updatedAt) ?? 0,
    items: [] satisfies SessionWorkStateItemV1[],
    primaryItemId: null,
  };
  // Primary is re-resolved canonically at the merge chokepoint after the Codex
  // goal item is removed; no Codex-local primary computation here.
  return {
    ...metadata,
    ...mergeSessionWorkStateMetadataV1({
      metadata,
      nextOwned,
      ownedItemIds,
      ownedItemIdPrefixes: [LEGACY_CODEX_GOAL_ITEM_PREFIX],
    }),
  };
}
