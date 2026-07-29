import {
  mergeSessionWorkStateMetadataV1,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
  type SessionWorkStateWriteSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';
import { decodeCodexAppServerGoal, normalizeCodexGoalTimestampMs } from './goalCodec.js';

type MetadataRecord = Record<string, unknown>;
const CODEX_BACKEND_ID = 'codex';
const LEGACY_CODEX_GOAL_ITEM_ID = 'goal:codex:thread';
const LEGACY_CODEX_GOAL_ITEM_PREFIX = 'goal:codex:';

const CODEX_GOAL_PROJECTION_FIELD = 'codexGoalProjectionV1';

type CodexGoalProjectionV1 = Readonly<{
  v: 1;
  threadId: string;
  updatedAt: number;
  state: 'present' | 'cleared';
}>;

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
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readProjection(metadata: unknown): CodexGoalProjectionV1 | null {
  const record = asRecord(asRecord(metadata)?.[CODEX_GOAL_PROJECTION_FIELD]);
  const threadId = readString(record?.threadId);
  const updatedAt = readNonNegativeInteger(record?.updatedAt);
  const state = record?.state;
  if (record?.v !== 1 || !threadId || updatedAt === null || (state !== 'present' && state !== 'cleared')) {
    return null;
  }
  return { v: 1, threadId, updatedAt, state };
}

function deriveProjection(metadata: unknown): CodexGoalProjectionV1 | null {
  const explicit = readProjection(metadata);
  if (explicit) return explicit;
  const current = readItems(asRecord(asRecord(metadata)?.sessionWorkStateV1)?.items).find(isCodexGoalItem);
  const threadId = readString(current?.vendorRef);
  const updatedAt = readNonNegativeInteger(current?.updatedAt);
  return threadId && updatedAt !== null ? { v: 1, threadId, updatedAt, state: 'present' } : null;
}

function withProjection<TMetadata extends object>(
  metadata: TMetadata,
  projection: CodexGoalProjectionV1,
): TMetadata & { codexGoalProjectionV1: CodexGoalProjectionV1 } {
  return { ...metadata, codexGoalProjectionV1: projection };
}

function readCurrentWorkState(metadata: unknown, backendId: string): SessionWorkStateWriteSnapshotV1 {
  const current = asRecord(asRecord(metadata)?.sessionWorkStateV1) ?? {};
  return {
    ...current,
    v: 1 as const,
    backendId: readString(current.backendId) ?? backendId,
    updatedAt: readNonNegativeInteger(current.updatedAt) ?? 0,
    items: readItems(current.items),
  };
}

function preserveCurrentWorkState<TMetadata extends object>(
  metadata: TMetadata,
  backendId: string,
): TMetadata & { sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 } {
  return {
    ...metadata,
    sessionWorkStateV1: readCurrentWorkState(metadata, backendId),
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
  const item = decodeCodexAppServerGoal({
    backendId,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    goal,
  });

  if (!item) return preserveCurrentWorkState(metadata, backendId);

  const projection = deriveProjection(metadata);
  if (projection && projection.threadId === item.vendorRef && (
    projection.updatedAt >= item.updatedAt
  )) {
    return preserveCurrentWorkState(metadata, backendId);
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
    ...withProjection(metadata, { v: 1, threadId: item.vendorRef, updatedAt: item.updatedAt, state: 'present' }),
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
    threadId?: string;
    updatedAt?: string | number;
  }> = {},
): TMetadata & { sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 } {
  const backendId = options.backendId ?? CODEX_BACKEND_ID;
  const current = readCurrentWorkState(metadata, backendId);
  const projection = deriveProjection(metadata);
  const threadId = readString(options.threadId)
    ?? projection?.threadId
    ?? readItems(current.items).map((item) => readString(item.vendorRef)).find(Boolean)
    ?? null;
  const explicitUpdatedAt = normalizeCodexGoalTimestampMs(options.updatedAt);
  if (projection && threadId && projection.threadId !== threadId) {
    return preserveCurrentWorkState(metadata, backendId);
  }
  if (explicitUpdatedAt !== null && projection && explicitUpdatedAt < projection.updatedAt) {
    return preserveCurrentWorkState(metadata, backendId);
  }
  const clearedAt = explicitUpdatedAt ?? projection?.updatedAt ?? readNonNegativeInteger(current.updatedAt) ?? 0;
  const ownedItemIds = readItems(current.items)
    .filter(isCodexGoalItem)
    .map((item) => readString(item.id))
    .filter((id): id is string => Boolean(id));

  const nextOwned: SessionWorkStateV1 = {
    v: 1,
    backendId,
    updatedAt: clearedAt,
    items: [] satisfies SessionWorkStateItemV1[],
    primaryItemId: null,
  };
  // Primary is re-resolved canonically at the merge chokepoint after the Codex
  // goal item is removed; no Codex-local primary computation here.
  const metadataWithProjection = threadId
    ? withProjection(metadata, { v: 1, threadId, updatedAt: clearedAt, state: 'cleared' })
    : metadata;
  return {
    ...metadataWithProjection,
    ...mergeSessionWorkStateMetadataV1({
      metadata,
      nextOwned,
      ownedItemIds,
      ownedItemIdPrefixes: [LEGACY_CODEX_GOAL_ITEM_PREFIX],
    }),
  };
}
