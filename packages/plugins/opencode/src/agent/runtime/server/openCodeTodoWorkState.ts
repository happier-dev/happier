import {
  boundSessionWorkStateItemsV1,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

export const OPEN_CODE_TODO_WORK_STATE_OWNED_SOURCE_FAMILIES = ['todo:opencode'] as const;
export const OPEN_CODE_TODO_WORK_STATE_ITEM_LIMIT = 100;

type OpenCodeTodoRecord = Readonly<{
  id?: string;
  content: string;
  status: string;
  priority?: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOpenCodeTodoRecord(value: unknown): OpenCodeTodoRecord | null {
  const record = asRecord(value);
  if (!record) return null;

  const content = readNonEmptyString(record.content);
  const status = readNonEmptyString(record.status);
  if (!content || !status) return null;

  const id = readNonEmptyString(record.id);
  const priority = readNonEmptyString(record.priority);
  return {
    ...(id ? { id } : {}),
    content,
    status,
    ...(priority ? { priority } : {}),
  };
}

function normalizeOpenCodeTodoStatus(status: string): SessionWorkStateItemV1['status'] {
  if (status === 'pending') return 'pending';
  if (status === 'in_progress') return 'active';
  if (status === 'completed') return 'complete';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
}

function encodeOpenCodeTodoIdPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOpenCodeTodoItemId(params: Readonly<{
  vendorRef?: string;
  content: string;
  index: number;
}>): string {
  if (params.vendorRef) return `todo:opencode:${encodeOpenCodeTodoIdPart(params.vendorRef)}`;
  return `todo:opencode:derived:${encodeOpenCodeTodoIdPart(`${params.content}|${params.index}`)}`;
}

function normalizeOpenCodeSessionTodosToWorkStateItems(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  todos: unknown;
}>): SessionWorkStateItemV1[] {
  const todos = Array.isArray(params.todos) ? params.todos : [];
  return todos.flatMap((todo, index): SessionWorkStateItemV1[] => {
    const parsed = readOpenCodeTodoRecord(todo);
    if (!parsed) return [];

    return [{
      id: buildOpenCodeTodoItemId({
        ...(parsed.id ? { vendorRef: parsed.id } : {}),
        content: parsed.content,
        index,
      }),
      kind: 'todo',
      origin: 'vendor',
      status: normalizeOpenCodeTodoStatus(parsed.status),
      title: parsed.content,
      backendId: params.backendId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(parsed.id ? { vendorRef: parsed.id } : {}),
      order: index,
      ...(parsed.priority ? { priority: parsed.priority } : {}),
      updatedAt: params.updatedAt,
    }];
  });
}

function choosePrimaryTodoItem(items: readonly SessionWorkStateItemV1[]): string | null {
  return (
    items.find((item) => item.status === 'active')?.id
    ?? items.find((item) => item.status === 'pending' && item.priority === 'high')?.id
    ?? items.find((item) => item.status === 'pending')?.id
    ?? null
  );
}

function rankOpenCodeTodoItemForSnapshot(item: SessionWorkStateItemV1): number {
  if (item.status === 'active') return 0;
  if (item.status === 'pending' && item.priority === 'high') return 1;
  if (item.status === 'pending') return 2;
  return 3;
}

function orderOpenCodeTodoItemsForSnapshot(
  items: readonly SessionWorkStateItemV1[],
): SessionWorkStateItemV1[] {
  return [...items].sort((left, right) => {
    const rankDelta = rankOpenCodeTodoItemForSnapshot(left) - rankOpenCodeTodoItemForSnapshot(right);
    if (rankDelta !== 0) return rankDelta;
    return (left.order ?? 0) - (right.order ?? 0);
  });
}

export function buildOpenCodeTodoWorkState(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  todos: unknown;
  maxItems?: number | null;
}>): SessionWorkStateV1 {
  const normalizedItems = normalizeOpenCodeSessionTodosToWorkStateItems({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    todos: params.todos,
  });
  const orderedItems = orderOpenCodeTodoItemsForSnapshot(normalizedItems);
  const bounded = boundSessionWorkStateItemsV1({
    items: orderedItems,
    maxItems: params.maxItems ?? OPEN_CODE_TODO_WORK_STATE_ITEM_LIMIT,
  });

  return {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    items: bounded.items,
    primaryItemId: choosePrimaryTodoItem(bounded.items),
    ...(bounded.truncated ? { truncated: bounded.truncated } : {}),
  };
}
