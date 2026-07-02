import {
  boundSessionWorkStateItemsV1,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
} from '@happier-dev/protocol';

export const CURSOR_TODO_WORK_STATE_OWNED_SOURCE_FAMILIES = ['todo:cursor'] as const;
const CURSOR_TODO_WORK_STATE_ITEM_LIMIT = 100;

export type CursorTodo = Readonly<{
  id?: string;
  content: string;
  status: string;
}>;

function encodeCursorTodoIdPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildCursorTodoItemId(params: Readonly<{
  vendorRef?: string;
  content: string;
  index: number;
}>): string {
  if (params.vendorRef) return `todo:cursor:${encodeCursorTodoIdPart(params.vendorRef)}`;
  return `todo:cursor:derived:${encodeCursorTodoIdPart(`${params.content}|${params.index}`)}`;
}

function normalizeCursorTodoStatus(status: string): SessionWorkStateItemV1['status'] {
  if (status === 'pending') return 'pending';
  if (status === 'in_progress' || status === 'inProgress' || status === 'active') return 'active';
  if (status === 'completed' || status === 'complete' || status === 'done') return 'complete';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'blocked') return 'blocked';
  if (status === 'paused') return 'paused';
  return 'pending';
}

function choosePrimaryTodoItem(items: readonly SessionWorkStateItemV1[]): string | null {
  return (
    items.find((item) => item.status === 'active')?.id
    ?? items.find((item) => item.status === 'pending')?.id
    ?? items.find((item) => item.status === 'blocked')?.id
    ?? null
  );
}

function rankCursorTodoItemForSnapshot(item: SessionWorkStateItemV1): number {
  if (item.status === 'active') return 0;
  if (item.status === 'pending') return 1;
  if (item.status === 'blocked') return 2;
  return 3;
}

export function buildCursorTodoWorkState(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  todos: readonly CursorTodo[];
  maxItems?: number | null;
}>): SessionWorkStateV1 {
  const items = params.todos.map((todo, index): SessionWorkStateItemV1 => ({
    id: buildCursorTodoItemId({
      ...(todo.id ? { vendorRef: todo.id } : {}),
      content: todo.content,
      index,
    }),
    kind: 'todo',
    origin: 'vendor',
    status: normalizeCursorTodoStatus(todo.status),
    title: todo.content,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(todo.id ? { vendorRef: todo.id } : {}),
    order: index,
    updatedAt: params.updatedAt,
  }));
  const orderedItems = [...items].sort((left, right) => {
    const rankDelta = rankCursorTodoItemForSnapshot(left) - rankCursorTodoItemForSnapshot(right);
    if (rankDelta !== 0) return rankDelta;
    return (left.order ?? 0) - (right.order ?? 0);
  });
  const bounded = boundSessionWorkStateItemsV1({
    items: orderedItems,
    maxItems: params.maxItems ?? CURSOR_TODO_WORK_STATE_ITEM_LIMIT,
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
