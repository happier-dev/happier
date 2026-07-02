import {
  mergeSessionWorkStateMetadataV1,
  normalizeCodexAppServerGoalToSessionWorkStateItem,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
  type SessionWorkStateWriteItemV1,
  type SessionWorkStateWriteSnapshotV1,
} from '@happier-dev/protocol';

type MetadataRecord = Record<string, unknown>;

const CODEX_BACKEND_ID = 'codex';
const LEGACY_CODEX_GOAL_ITEM_ID = 'goal:codex:thread';
const LEGACY_CODEX_GOAL_ITEM_PREFIX = 'goal:codex:';

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

function readItemId(item: unknown): string | null {
  return readString(asRecord(item)?.id);
}

function isTaskOrTodo(item: MetadataRecord): boolean {
  return item.kind === 'task' || item.kind === 'todo';
}

function isCodexGoalItem(item: MetadataRecord): boolean {
  const id = readString(item.id);
  if (id === LEGACY_CODEX_GOAL_ITEM_ID) return true;
  if (id?.startsWith(LEGACY_CODEX_GOAL_ITEM_PREFIX)) return true;
  return item.kind === 'goal'
    && item.origin === 'vendor'
    && item.backendId === CODEX_BACKEND_ID;
}

function choosePrimaryItemId(
  items: readonly SessionWorkStateWriteItemV1[],
  currentPrimaryItemId: string | null,
  preferredGoalItemId?: string,
): string | null {
  const records = items.map(asRecord).filter((item): item is MetadataRecord => Boolean(item));
  if (currentPrimaryItemId) {
    const current = records.find((item) => item.id === currentPrimaryItemId);
    if (current && isTaskOrTodo(current)) {
      return currentPrimaryItemId;
    }
  }
  const activeTaskOrTodo = records.find((item) =>
    isTaskOrTodo(item) && item.status === 'active' && typeof item.id === 'string',
  );
  if (typeof activeTaskOrTodo?.id === 'string') return activeTaskOrTodo.id;
  if (preferredGoalItemId && records.some((item) => item.id === preferredGoalItemId)) {
    return preferredGoalItemId;
  }
  const activeGoal = records.find((item) => item.kind === 'goal' && item.status === 'active' && typeof item.id === 'string');
  if (typeof activeGoal?.id === 'string') return activeGoal.id;
  return records.map(readItemId).find((id): id is string => Boolean(id)) ?? null;
}

function withPrimaryItemId(
  snapshot: SessionWorkStateWriteSnapshotV1,
  currentPrimaryItemId: string | null,
  preferredGoalItemId?: string,
): SessionWorkStateWriteSnapshotV1 {
  return {
    ...snapshot,
    primaryItemId: choosePrimaryItemId(snapshot.items, currentPrimaryItemId, preferredGoalItemId),
  };
}

function withSessionWorkStateMetadata<TMetadata extends object>(
  metadata: TMetadata,
  sessionWorkStateV1: SessionWorkStateWriteSnapshotV1,
): TMetadata & { sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 } {
  return {
    ...metadata,
    sessionWorkStateV1,
  };
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
  const nextMetadata: MetadataRecord & Readonly<{ sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 }> = mergeSessionWorkStateMetadataV1({
    metadata,
    nextOwned,
    ownedItemIds: [...existingCodexGoalItemIds, item.id, LEGACY_CODEX_GOAL_ITEM_ID],
    ownedItemIdPrefixes: [LEGACY_CODEX_GOAL_ITEM_PREFIX],
  });

  return withSessionWorkStateMetadata(
    metadata,
    withPrimaryItemId(nextMetadata.sessionWorkStateV1, readString(current.primaryItemId), item.id),
  );
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
  const nextMetadata: MetadataRecord & Readonly<{ sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 }> = mergeSessionWorkStateMetadataV1({
    metadata,
    nextOwned,
    ownedItemIds,
    ownedItemIdPrefixes: [LEGACY_CODEX_GOAL_ITEM_PREFIX],
  });

  return withSessionWorkStateMetadata(
    metadata,
    withPrimaryItemId(nextMetadata.sessionWorkStateV1, readString(current.primaryItemId)),
  );
}
