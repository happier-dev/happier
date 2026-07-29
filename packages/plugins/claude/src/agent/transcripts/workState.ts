import type {
  RuntimeOutboundTranscriptDispatchInputV1,
  RuntimeOutboundTranscriptPostSendEffectV1,
} from '@happier-dev/agents';
import {
  boundSessionWorkStateItemsV1,
  mergeSessionWorkStateMetadataV1,
  readSessionWorkStateV1FromMetadata,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import { normalizeClaudeActivityStatusSignal } from '../activityStatus.js';
import { filterWorkflowOwnedWorkStateItems } from '../workflowRecords/ownedWorkState.js';
import { resolveClaudeWorkflowOwnedToolUseIds } from '../workflowRecords/ownedWorkStateRegistry.js';

const CLAUDE_WORK_STATE_BACKEND_ID = 'claude';
const CLAUDE_WORK_STATE_AGENT_ID = 'claude';
/**
 * Canonical id prefix for Claude Task API rows. These are `kind:'task'` items (DW1): the Claude Task
 * API (`TaskCreate`/`TaskUpdate`/`TaskList`) is a real task list, so it maps to the protocol's `task`
 * family — matching remote-dev — not to `todo`. `TodoWrite` (a separate, checklist-style tool) is the
 * only legitimate `todo` source; ../dev does not project it today, so every row here is a task.
 */
const CLAUDE_TASK_ITEM_ID_PREFIX = 'task:claude:';
/**
 * Legacy prefix these rows were emitted under before DW1 (as `kind:'todo'`). Existing sessions may
 * still carry `todo:claude:` rows in `metadata.sessionWorkStateV1`. On the next Task API dispatch they
 * are migrated in-place to the `task:claude:` id + `kind:'task'` (see `readCurrentClaudeTaskItems`),
 * and the merge owns BOTH prefixes so the stale legacy id is pruned rather than left as a duplicate.
 */
const CLAUDE_LEGACY_TASK_ITEM_ID_PREFIX = 'todo:claude:';
const CLAUDE_TASK_ITEM_LIMIT = 100;

type TaskStatus = SessionWorkStateItemV1['status'] | 'deleted';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function readContentBlocks(body: unknown): readonly unknown[] {
  const content = asRecord(asRecord(body)?.message)?.content;
  return Array.isArray(content) ? content : [];
}

function encodeClaudeTaskIdPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildClaudeTaskItemId(vendorRef: string): string {
  return `${CLAUDE_TASK_ITEM_ID_PREFIX}${encodeClaudeTaskIdPart(vendorRef)}`;
}

function normalizeTaskStatus(value: unknown): TaskStatus | null {
  // Work-state-only statuses the neutral activity signal does not carry.
  if (value === 'deleted') return 'deleted';
  if (value === 'paused') return 'paused';
  if (value === 'unknown') return 'unknown';
  // Delegate to the single shared Claude activity-status classifier (no parallel status table).
  const signal = normalizeClaudeActivityStatusSignal(value);
  // Work-state has no `failed`; provider failures surface as `blocked`.
  if (signal === 'failed') return 'blocked';
  // Preserve the prior contract: an unrecognized value maps to null (fall back to previous status),
  // not a synthesized `unknown`.
  if (signal === 'unknown') return null;
  return signal;
}

function readTaskTitle(record: Record<string, unknown>): string | null {
  return (
    readString(record.subject)
    ?? readString(record.title)
    ?? readString(record.content)
    ?? readString(record.description)
    ?? readString(record.activeForm)
  );
}

function normalizePriority(value: unknown): string {
  const priority = readString(value);
  return priority ?? 'medium';
}

function readJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function readTaskRecordFromPlainTextResult(text: string): Record<string, unknown> | null {
  const match = text.trim().match(/^Task\s+#?([A-Za-z0-9_.:-]+)\s+created\s+successfully:\s+([\s\S]+)$/iu);
  const id = match?.[1]?.trim();
  const subject = match?.[2]?.trim();
  return id && subject ? { id, subject } : null;
}

type TaskRecordsReadResult = Readonly<{
  records: readonly unknown[];
  replaceOwnedSnapshot: boolean;
}>;

function readTaskRecordsFromPayload(payload: unknown): TaskRecordsReadResult {
  if (typeof payload === 'string') {
    const task = readTaskRecordFromPlainTextResult(payload);
    return { records: task ? [task] : [], replaceOwnedSnapshot: false };
  }

  const record = asRecord(payload);
  if (!record) return { records: [], replaceOwnedSnapshot: false };

  const snakeResult = asRecord(record.tool_use_result);
  if (snakeResult) return readTaskRecordsFromPayload(snakeResult);

  const camelResult = asRecord(record.toolUseResult);
  if (camelResult) return readTaskRecordsFromPayload(camelResult);

  if (Array.isArray(record.tasks)) {
    return { records: record.tasks, replaceOwnedSnapshot: true };
  }

  const task = asRecord(record.task);
  return { records: task ? [task] : [], replaceOwnedSnapshot: false };
}

function readToolResultPayloads(value: unknown): readonly unknown[] {
  const payloads: unknown[] = [];
  const block = asRecord(value);
  if (block?.tool_use_result !== undefined && block.tool_use_result !== null) payloads.push(block.tool_use_result);
  if (block?.toolUseResult !== undefined && block.toolUseResult !== null) payloads.push(block.toolUseResult);
  if (payloads.flatMap((payload) => readTaskRecordsFromPayload(payload).records).length > 0) return payloads;

  const content = block ? block.content : value;
  if (typeof content === 'string') {
    payloads.push(...[readJsonValue(content), content].filter((entry) => entry !== null));
  } else if (Array.isArray(content)) {
    payloads.push(...content.flatMap((entry): unknown[] => {
      const record = asRecord(entry);
      if (!record) return [entry];
      const text = readString(record.text);
      if (text) return [readJsonValue(text), text].filter((next) => next !== null);
      return [record];
    }));
  } else if (content !== undefined && content !== null) {
    payloads.push(content);
  }
  return payloads;
}

function findClaudeTaskItemByVendorRef(
  items: Iterable<SessionWorkStateItemV1>,
  vendorRef: string,
): SessionWorkStateItemV1 | undefined {
  for (const item of items) {
    if (item.vendorRef === vendorRef || item.id === buildClaudeTaskItemId(vendorRef)) {
      return item;
    }
  }
  return undefined;
}

function normalizeTaskRecord(params: Readonly<{
  record: unknown;
  fallbackVendorRef: string | null;
  updatedAt: number;
  previous?: SessionWorkStateItemV1;
}>): SessionWorkStateItemV1 | 'deleted' | null {
  const task = asRecord(params.record);
  if (!task) return null;

  const status = normalizeTaskStatus(task.status);
  const vendorRef = readString(task.id) ?? readString(task.taskId) ?? params.fallbackVendorRef;
  if (!vendorRef) return null;
  if (status === 'deleted') return 'deleted';

  const title = readTaskTitle(task) ?? params.previous?.title ?? vendorRef;
  const item: SessionWorkStateItemV1 = {
    id: buildClaudeTaskItemId(vendorRef),
    kind: 'task',
    origin: 'vendor',
    status: status ?? params.previous?.status ?? 'pending',
    title,
    backendId: CLAUDE_WORK_STATE_BACKEND_ID,
    agentId: CLAUDE_WORK_STATE_AGENT_ID,
    vendorRef,
    priority: normalizePriority(task.priority ?? params.previous?.priority),
    updatedAt: params.updatedAt,
  };
  return item;
}

function choosePrimaryTaskItem(items: readonly SessionWorkStateItemV1[]): string | null {
  return (
    items.find((item) => item.status === 'active')?.id
    ?? items.find((item) => item.status === 'pending' && item.priority === 'high')?.id
    ?? items.find((item) => item.status === 'pending')?.id
    ?? items.find((item) => item.status === 'blocked')?.id
    ?? null
  );
}

function rankTaskItem(item: SessionWorkStateItemV1): number {
  if (item.status === 'active') return 0;
  if (item.status === 'pending' && item.priority === 'high') return 1;
  if (item.status === 'pending') return 2;
  if (item.status === 'blocked') return 3;
  if (item.status === 'paused') return 4;
  if (item.status === 'complete') return 5;
  if (item.status === 'cancelled') return 6;
  return 7;
}

function orderTaskItems(items: Iterable<SessionWorkStateItemV1>): SessionWorkStateItemV1[] {
  return [...items].sort((left, right) => {
    const rankDelta = rankTaskItem(left) - rankTaskItem(right);
    if (rankDelta !== 0) return rankDelta;
    return left.title.localeCompare(right.title);
  });
}

function buildSnapshot(params: Readonly<{
  items: Iterable<SessionWorkStateItemV1>;
  updatedAt: number;
}>): SessionWorkStateV1 {
  const orderedItems = orderTaskItems(params.items);
  const bounded = boundSessionWorkStateItemsV1({
    items: orderedItems,
    maxItems: CLAUDE_TASK_ITEM_LIMIT,
  });
  return {
    v: 1,
    backendId: CLAUDE_WORK_STATE_BACKEND_ID,
    agentId: CLAUDE_WORK_STATE_AGENT_ID,
    updatedAt: params.updatedAt,
    items: bounded.items,
    primaryItemId: choosePrimaryTaskItem(bounded.items),
    ...(bounded.truncated ? { truncated: bounded.truncated } : {}),
  };
}

/**
 * Migrate a pre-DW1 `todo:claude:` task row to the canonical `task:claude:` id + `kind:'task'`,
 * preserving its `vendorRef` so the new id stays stable across the legacy row (the vendorRef, not the
 * encoded id suffix, is the correlation key). Falls back to decoding the legacy id suffix only if the
 * row somehow carries no `vendorRef`.
 */
function migrateLegacyClaudeTaskItem(item: SessionWorkStateItemV1): SessionWorkStateItemV1 {
  const decodedSuffix = (() => {
    try {
      return decodeURIComponent(item.id.slice(CLAUDE_LEGACY_TASK_ITEM_ID_PREFIX.length));
    } catch {
      return null;
    }
  })();
  const vendorRef = readString(item.vendorRef) ?? readString(decodedSuffix) ?? item.id;
  return {
    ...item,
    id: buildClaudeTaskItemId(vendorRef),
    kind: 'task',
    vendorRef,
  };
}

function readCurrentClaudeTaskItems(metadata: unknown): Map<string, SessionWorkStateItemV1> {
  const current = readSessionWorkStateV1FromMetadata(metadata);
  const items = new Map<string, SessionWorkStateItemV1>();
  for (const item of current?.items ?? []) {
    if (item.id.startsWith(CLAUDE_TASK_ITEM_ID_PREFIX)) {
      items.set(item.id, item);
      continue;
    }
    // DW1 migration: reclassify a legacy `todo:claude:` task row as a `task:claude:` task. Keyed by
    // the migrated id so a later TaskUpdate for the same vendorRef updates this row (no duplicate),
    // and the legacy id is pruned by the merge (which owns both prefixes).
    if (item.id.startsWith(CLAUDE_LEGACY_TASK_ITEM_ID_PREFIX)) {
      const migrated = migrateLegacyClaudeTaskItem(item);
      items.set(migrated.id, migrated);
    }
  }
  return items;
}

function applyToolUseBlock(params: Readonly<{
  items: Map<string, SessionWorkStateItemV1>;
  block: Record<string, unknown>;
  updatedAt: number;
}>): boolean {
  const toolUseId = readString(params.block.id);
  const toolName = readString(params.block.name);
  if (!toolUseId || !toolName) return false;

  if (toolName === 'TaskList') {
    return false;
  }

  if (toolName === 'TaskCreate') {
    const vendorRef = `tool_use:${toolUseId}`;
    const previous = findClaudeTaskItemByVendorRef(params.items.values(), vendorRef);
    const item = normalizeTaskRecord({
      record: params.block.input,
      fallbackVendorRef: vendorRef,
      previous,
      updatedAt: params.updatedAt,
    });
    if (!item || item === 'deleted') return false;
    params.items.set(item.id, item);
    return true;
  }

  if (toolName !== 'TaskUpdate') return false;

  const input = asRecord(params.block.input);
  const taskId = readString(input?.taskId);
  if (!input || !taskId) return false;
  const previous = findClaudeTaskItemByVendorRef(params.items.values(), taskId);
  const item = normalizeTaskRecord({
    record: input,
    fallbackVendorRef: taskId,
    previous,
    updatedAt: params.updatedAt,
  });
  if (item === 'deleted') {
    params.items.delete(buildClaudeTaskItemId(taskId));
    return true;
  }
  if (!item) return false;
  if (!readTaskTitle(input) && !previous) return false;
  params.items.set(item.id, item);
  return true;
}

function applyToolResultBlock(params: Readonly<{
  items: Map<string, SessionWorkStateItemV1>;
  block: Record<string, unknown>;
  updatedAt: number;
}>): boolean {
  const toolUseId = readString(params.block.tool_use_id);
  let changed = false;
  let replaceOwnedSnapshot = false;
  const records: unknown[] = [];
  for (const payload of readToolResultPayloads(params.block)) {
    const result = readTaskRecordsFromPayload(payload);
    records.push(...result.records);
    replaceOwnedSnapshot = replaceOwnedSnapshot || result.replaceOwnedSnapshot;
  }

  if (replaceOwnedSnapshot) {
    params.items.clear();
    changed = true;
  }

  const provisionalVendorRef = toolUseId ? `tool_use:${toolUseId}` : null;
  const provisional = provisionalVendorRef
    ? findClaudeTaskItemByVendorRef(params.items.values(), provisionalVendorRef)
    : undefined;

  for (const record of records) {
    const fallbackVendorRef = provisionalVendorRef;
    const item = normalizeTaskRecord({
      record,
      fallbackVendorRef,
      previous: provisional,
      updatedAt: params.updatedAt,
    });
    if (item === 'deleted') {
      const taskId = readString(asRecord(record)?.id) ?? readString(asRecord(record)?.taskId);
      if (taskId) {
        params.items.delete(buildClaudeTaskItemId(taskId));
        changed = true;
      }
      continue;
    }
    if (!item) continue;
    if (provisional) {
      params.items.delete(provisional.id);
    }
    params.items.set(item.id, item);
    changed = true;
  }

  return changed;
}

export function buildClaudeTaskWorkStatePostSendEffect(
  input: RuntimeOutboundTranscriptDispatchInputV1,
): RuntimeOutboundTranscriptPostSendEffectV1 | null {
  const updatedAt = input.now?.() ?? Date.now();
  const items = readCurrentClaudeTaskItems(input.metadata);
  let changed = false;

  for (const block of readContentBlocks(input.body)) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === 'tool_use') {
      changed = applyToolUseBlock({ items, block: record, updatedAt }) || changed;
      continue;
    }
    if (record.type === 'tool_result') {
      changed = applyToolResultBlock({ items, block: record, updatedAt }) || changed;
    }
  }

  if (!changed) return null;

  // CWF4 coherence: a canonical Workflow run's agents live in the durable `activity/workflow_run.v1`
  // record + the workflow UI surfaces. Drop any task rows the workflow normalizer marked
  // workflow-owned (by their tool-use `vendorRef`/owning `parentId`) BEFORE the merge, so they do not
  // ALSO render as top-level task rows. The owned ids come from the per-session workflow runtime via a
  // narrow registry (no provider-name branch, no Claude-native id matching in the merge). No-op when
  // no workflow run is active or the session has no registered runtime.
  const builtSnapshot = buildSnapshot({ items: items.values(), updatedAt });
  const nextOwned = filterWorkflowOwnedWorkStateItems(
    builtSnapshot,
    resolveClaudeWorkflowOwnedToolUseIds(input.sessionId),
  );
  const mergedMetadata = mergeSessionWorkStateMetadataV1({
    metadata: input.metadata,
    nextOwned,
    // Own the legacy prefix too so a pre-DW1 `todo:claude:` row (migrated above into a new-id task)
    // is pruned from the merged set instead of lingering as a duplicate.
    ownedItemIdPrefixes: [CLAUDE_TASK_ITEM_ID_PREFIX, CLAUDE_LEGACY_TASK_ITEM_ID_PREFIX],
  });
  return {
    type: 'metadataField',
    fieldId: 'runtime.workState',
    value: readSessionWorkStateV1FromMetadata(mergedMetadata) ?? nextOwned,
    reason: 'reconciliation',
    metadataReason: 'mirror_claude_task_state',
  };
}
