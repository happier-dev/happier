import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import {
  mergeSessionWorkStateMetadataV1,
  readSessionWorkStateV1FromMetadata,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import {
  CURSOR_TODO_WORK_STATE_OWNED_SOURCE_FAMILIES,
  buildCursorTodoWorkState,
  type CursorTodo,
} from './workState.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCursorTodo(value: unknown, phaseName?: string): CursorTodo | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawContent = readString(value.content) ?? readString(value.text) ?? readString(value.title);
  if (!rawContent) {
    return null;
  }
  const status = readString(value.status) ?? 'pending';
  const id = readString(value.id);
  const content = phaseName ? `${phaseName}: ${rawContent}` : rawContent;
  return Object.freeze({
    ...(id ? { id } : {}),
    content,
    status,
  });
}

export function readCursorTodos(params: unknown): readonly CursorTodo[] | null {
  if (!isRecord(params) || !Object.prototype.hasOwnProperty.call(params, 'todos') || !Array.isArray(params.todos)) {
    return null;
  }
  return Object.freeze(params.todos
    .map((todo) => normalizeCursorTodo(todo))
    .filter((todo): todo is CursorTodo => todo !== null));
}

export function readCursorPlanTodos(params: unknown): readonly CursorTodo[] {
  if (!isRecord(params)) {
    return [];
  }
  const directTodos = readCursorTodos(params);
  if (directTodos && directTodos.length > 0) {
    return directTodos;
  }
  if (!Array.isArray(params.phases)) {
    return [];
  }
  const todos: CursorTodo[] = [];
  for (const phase of params.phases) {
    if (!isRecord(phase) || !Array.isArray(phase.todos)) {
      continue;
    }
    const phaseName = readString(phase.name) ?? readString(phase.title) ?? undefined;
    for (const todo of phase.todos) {
      const normalized = normalizeCursorTodo(todo, phaseName);
      if (normalized) {
        todos.push(normalized);
      }
    }
  }
  return Object.freeze(todos);
}

export function mergeCursorTodos(previous: readonly CursorTodo[], next: readonly CursorTodo[]): readonly CursorTodo[] {
  const byId = new Map<string, CursorTodo>();
  const anonymous: CursorTodo[] = [];
  for (const todo of previous) {
    if (todo.id) {
      byId.set(todo.id, todo);
    } else {
      anonymous.push(todo);
    }
  }
  for (const todo of next) {
    if (todo.id) {
      byId.set(todo.id, todo);
    } else {
      anonymous.push(todo);
    }
  }
  return Object.freeze([...byId.values(), ...anonymous]);
}

async function readCurrentSessionMetadata(ctx: PluginContextV1): Promise<Readonly<Record<string, unknown>>> {
  const currentSessions = await ctx.sessions.list({ currentOnly: true });
  const currentSessionId = readString(ctx.sessions.current.sessionId);
  const currentSession = currentSessionId
    ? currentSessions.find((session) => session.sessionId === currentSessionId)
    : currentSessions[0];
  return currentSession?.metadata ?? {};
}

export async function writeCursorTodoWorkState(params: Readonly<{
  ctx: PluginContextV1;
  todos: readonly CursorTodo[];
}>): Promise<void> {
  const snapshot = buildCursorTodoWorkState({
    backendId: 'cursor',
    agentId: 'cursor',
    updatedAt: Date.now(),
    todos: params.todos,
  });
  let metadata: Readonly<Record<string, unknown>> = {};
  try {
    metadata = await readCurrentSessionMetadata(params.ctx);
  } catch (error) {
    params.ctx.logger.debug('Cursor ACP todo work-state metadata read failed; using Cursor-owned snapshot', {
      error,
    });
  }
  const mergedMetadata = mergeSessionWorkStateMetadataV1({
    metadata,
    nextOwned: snapshot,
    ownedSourceFamilies: CURSOR_TODO_WORK_STATE_OWNED_SOURCE_FAMILIES,
  });
  await params.ctx.sessions.writeStateField({
    fieldId: 'runtime.workState',
    value: readSessionWorkStateV1FromMetadata(mergedMetadata) ?? snapshot,
    reason: 'cursor_todos_updated',
  });
}
