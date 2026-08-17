import type {
  WorkStateItem,
  WorkStateTruncation,
} from '@happier-dev/plugin-sdk/sessions/work-state';

const CURSOR_TODO_WORK_STATE_ITEM_LIMIT = 100;

export type CursorTodo = Readonly<{
  id?: string;
  content: string;
  status: string;
  phaseName?: string;
}>;

export type CursorTodoWorkStateSnapshot = Readonly<{
  items: readonly WorkStateItem[];
  primaryLocalId: string | null;
  truncation?: WorkStateTruncation;
}>;

function encodeCursorTodoIdPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildCursorTodoLocalId(params: Readonly<{
  providerRef?: string;
  content: string;
  index: number;
}>): string {
  if (params.providerRef) return `todo:cursor:${encodeCursorTodoIdPart(params.providerRef)}`;
  return `todo:cursor:derived:${encodeCursorTodoIdPart(`${params.content}|${params.index}`)}`;
}

function normalizeCursorTodoStatus(status: string): WorkStateItem['status'] {
  if (status === 'pending') return 'pending';
  if (status === 'in_progress' || status === 'inProgress' || status === 'active') return 'active';
  if (status === 'completed' || status === 'complete' || status === 'done') return 'complete';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'blocked') return 'blocked';
  if (status === 'paused') return 'paused';
  return 'pending';
}

function choosePrimaryTodoItem(items: readonly WorkStateItem[]): string | null {
  return items.find((item) => item.status === 'active')?.localId
    ?? items.find((item) => item.status === 'pending')?.localId
    ?? items.find((item) => item.status === 'blocked')?.localId
    ?? null;
}

function rankCursorTodoItemForSnapshot(item: WorkStateItem): number {
  if (item.status === 'active') return 0;
  if (item.status === 'pending') return 1;
  if (item.status === 'blocked') return 2;
  return 3;
}

export function buildCursorTodoWorkState(params: Readonly<{
  observedAtMs: number;
  todos: readonly CursorTodo[];
  maxItems?: number;
}>): CursorTodoWorkStateSnapshot {
  const items = params.todos.map((todo, index): WorkStateItem => ({
    localId: buildCursorTodoLocalId({
      ...(todo.id ? { providerRef: todo.id } : {}),
      content: todo.content,
      index,
    }),
    kind: 'todo',
    origin: 'vendor',
    status: normalizeCursorTodoStatus(todo.status),
    title: todo.content,
    ...(todo.id ? { providerRef: todo.id } : {}),
    ...(todo.phaseName ? { providerData: { phaseName: todo.phaseName } } : {}),
    order: index,
    updatedAtMs: params.observedAtMs,
  }));
  const orderedItems = [...items].sort((left, right) => {
    const rankDelta = rankCursorTodoItemForSnapshot(left) - rankCursorTodoItemForSnapshot(right);
    return rankDelta !== 0 ? rankDelta : (left.order ?? 0) - (right.order ?? 0);
  });
  const maxItems = params.maxItems ?? CURSOR_TODO_WORK_STATE_ITEM_LIMIT;
  const boundedItems = Object.freeze(orderedItems.slice(0, maxItems));
  const omittedCount = Math.max(0, orderedItems.length - boundedItems.length);
  return Object.freeze({
    items: boundedItems,
    primaryLocalId: choosePrimaryTodoItem(boundedItems),
    ...(omittedCount > 0
      ? { truncation: Object.freeze({ reason: 'itemLimit' as const, omittedCount }) }
      : {}),
  });
}
