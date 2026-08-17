import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

import { mergeCursorTodos } from '../extensions/todos.js';
import { buildCursorTodoWorkState, type CursorTodo } from './normalize.js';

export function createCursorTodoWorkStateUpdater(
  context: Pick<AgentSessionRuntimeContext, 'workState'>,
) {
  const publisher = context.workState.publisher('todos');
  let todos: readonly CursorTodo[] = Object.freeze([]);
  let sourceSequence = 0;
  let updateQueue = Promise.resolve();

  return function updateCursorTodoWorkState(params: Readonly<{
    todos: readonly CursorTodo[];
    merge: boolean;
    signal?: AbortSignal;
  }>): Promise<void> {
    const update = updateQueue.then(async () => {
      const nextTodos = params.merge
        ? mergeCursorTodos(todos, params.todos)
        : Object.freeze([...params.todos]);
      const observedAtMs = Date.now();
      const snapshot = buildCursorTodoWorkState({ observedAtMs, todos: nextTodos });
      const nextSourceSequence = sourceSequence + 1;
      const result = await publisher.publish({
        sourceSequence: nextSourceSequence,
        observedAtMs,
        items: snapshot.items,
        primaryLocalId: snapshot.primaryLocalId,
        ...(snapshot.truncation ? { truncation: snapshot.truncation } : {}),
      }, params.signal ? { signal: params.signal } : undefined);
      if (result.status !== 'applied' && result.status !== 'unchanged') {
        if (result.status === 'ignoredStale') {
          sourceSequence = Math.max(sourceSequence, result.currentSourceSequence);
        }
        throw new PluginError({
          code: `cursor_work_state_publish_${result.status === 'ignoredStale' ? 'stale' : result.status}`,
          message: 'Cursor work-state publication was not applied.',
          ...(result.status === 'conflict' || result.status === 'unavailable'
            ? { diagnostics: [result.diagnostic] }
            : {}),
        });
      }
      todos = nextTodos;
      sourceSequence = nextSourceSequence;
    });
    updateQueue = update.catch(() => undefined);
    return update;
  };
}
