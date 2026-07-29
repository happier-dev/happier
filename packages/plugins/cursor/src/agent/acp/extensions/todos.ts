import type { CursorTodo } from '../workState/normalize.js';
import type { CursorCreatePlanRequest, CursorTodoInput, CursorUpdateTodosRequest } from './schemas.js';

function normalizeCursorTodo(value: CursorTodoInput, phaseName?: string): CursorTodo {
  return Object.freeze({
    ...(value.id !== undefined ? { id: value.id } : {}),
    content: value.content ?? value.title!,
    status: value.status ?? 'pending',
    ...(phaseName ? { phaseName } : {}),
  });
}

export function readCursorTodos(params: CursorUpdateTodosRequest): readonly CursorTodo[] {
  return Object.freeze(params.todos.map((todo) => normalizeCursorTodo(todo)));
}

export function readCursorPlanTodos(params: CursorCreatePlanRequest): readonly CursorTodo[] {
  let todos: readonly CursorTodo[] = Object.freeze(
    (params.todos ?? []).map((todo) => normalizeCursorTodo(todo)),
  );
  for (const phase of params.phases ?? []) {
    for (const todo of phase.todos ?? []) {
      todos = mergeCursorTodos(todos, Object.freeze([normalizeCursorTodo(todo, phase.name)]));
    }
  }
  return todos;
}

export function mergeCursorTodos(previous: readonly CursorTodo[], next: readonly CursorTodo[]): readonly CursorTodo[] {
  const merged = [...previous];
  const positions = new Map<string, number>();
  previous.forEach((todo, index) => {
    if (todo.id !== undefined && !positions.has(todo.id)) positions.set(todo.id, index);
  });
  for (const todo of next) {
    if (todo.id !== undefined) {
      const position = positions.get(todo.id);
      if (position !== undefined) {
        merged[position] = todo;
        continue;
      }
      positions.set(todo.id, merged.length);
    }
    merged.push(todo);
  }
  return Object.freeze(merged);
}
