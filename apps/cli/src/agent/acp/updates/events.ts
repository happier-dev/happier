import type { HandlerContext, HandlerResult, SessionUpdate } from './types';

function extractThinkingText(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload.trim().length > 0 ? payload : null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const textCandidate = record.text ?? record.message ?? record.content;
  if (typeof textCandidate !== 'string') return null;
  return textCandidate.trim().length > 0 ? textCandidate : null;
}

export function handleAvailableCommandsUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const commands = Array.isArray(update.availableCommands) ? update.availableCommands : null;
  if (!commands) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'available_commands_update',
    payload: { availableCommands: commands },
  });
  return { handled: true };
}

export function handleCurrentModeUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : null;
  if (!modeId) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'current_mode_update',
    payload: { currentModeId: modeId },
  });
  return { handled: true };
}

/**
 * Stable synthetic tool-call id for the ACP plan checklist. ACP plan updates are full-replace,
 * so reusing one id lets each update refresh the same TodoView checklist in place.
 */
export const ACP_PLAN_TOOL_CALL_ID = 'acp-plan';

type AcpPlanTodo = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: string;
};

function normalizePlanEntryStatus(value: unknown): AcpPlanTodo['status'] {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (s === 'completed' || s === 'done') return 'completed';
  if (s === 'in_progress' || s === 'in-progress') return 'in_progress';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'pending';
}

function resolvePlanEntries(update: SessionUpdate): unknown[] | null {
  if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) return update.entries;
  const plan = update.plan;
  if (Array.isArray(plan)) return plan;
  if (plan && typeof plan === 'object' && Array.isArray((plan as Record<string, unknown>).entries)) {
    return (plan as Record<string, unknown>).entries as unknown[];
  }
  return null;
}

function planEntriesToTodos(entries: unknown[]): AcpPlanTodo[] {
  const todos: AcpPlanTodo[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const content =
      (typeof record.content === 'string' && record.content)
      || (typeof record.title === 'string' && record.title)
      || (typeof record.text === 'string' && record.text)
      || '';
    if (!content.trim()) continue;
    const todo: AcpPlanTodo = { content, status: normalizePlanEntryStatus(record.status) };
    if (typeof record.priority === 'string') todo.priority = record.priority;
    todos.push(todo);
  }
  return todos;
}

/**
 * Normalize a standard ACP `plan` SessionUpdate (`entries: [{content, priority, status}]`) into the
 * shared, cross-provider TodoWrite -> TodoView checklist, so any ACP provider's plan renders with the
 * same UI as Claude/Codex todos. This is the generic, centralized plan-rendering path.
 *
 * Providers that deliver plans through a richer proprietary channel (e.g. Cursor's
 * `cursor/create_plan` extension, which also carries markdown + phases) opt out via
 * `transport.suppressAcpPlanUpdate()` so we never render a duplicate checklist.
 */
export function handlePlanUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const entries = resolvePlanEntries(update);
  if (!entries) return { handled: false };

  if (ctx.transport.suppressAcpPlanUpdate?.()) return { handled: true };

  const todos = planEntriesToTodos(entries);
  if (todos.length === 0) return { handled: true };

  ctx.emit({ type: 'tool-call', toolName: 'TodoWrite', args: { todos }, callId: ACP_PLAN_TOOL_CALL_ID });
  ctx.emit({ type: 'tool-result', toolName: 'TodoWrite', result: { todos }, callId: ACP_PLAN_TOOL_CALL_ID });
  return { handled: true };
}

/**
 * Handle explicit thinking field.
 */
export function handleThinkingUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractThinkingText(update.thinking);
  if (!text) {
    return { handled: false };
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: { text },
  });

  return { handled: true };
}
