import { randomUUID } from 'node:crypto';

import type {
  AcpExtensionHandlerContext,
  AcpExtensionHandlers,
  AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';
import { logger } from '@/ui/logger';

type CursorQuestionOption = Readonly<{
  id?: unknown;
  label?: unknown;
}>;

type CursorQuestion = Readonly<{
  id?: unknown;
  prompt?: unknown;
  options?: unknown;
  allowMultiple?: unknown;
}>;

type PermissionDecision = Awaited<ReturnType<AcpPermissionHandler['handleToolCall']>> & {
  answers?: Readonly<Record<string, readonly string[]>>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readCursorToolCallId(params: Record<string, unknown>, fallbackPrefix: string): string {
  const toolCallId = readString(params.toolCallId);
  return toolCallId || `${fallbackPrefix}-${randomUUID()}`;
}

function readCursorQuestionOptions(rawOptions: unknown): ReadonlyArray<Readonly<{
  label: string;
  description: string;
}>> {
  const options = Array.isArray(rawOptions) ? rawOptions : [];
  const normalized = options
    .map((option) => asRecord(option) as CursorQuestionOption | null)
    .filter((option): option is CursorQuestionOption => Boolean(option))
    .map((option) => {
      const label = readString(option.label);
      return label ? { label, description: label } : null;
    })
    .filter((option): option is { label: string; description: string } => Boolean(option));
  return normalized.length > 0 ? normalized : [{ label: 'OK', description: 'Continue' }];
}

export function buildCursorAskQuestionInput(params: Record<string, unknown>): Record<string, unknown> {
  const title = readString(params.title) || 'Question';
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return {
    questions: questions
      .map((question) => asRecord(question) as CursorQuestion | null)
      .filter((question): question is CursorQuestion => Boolean(question))
      .map((question) => {
        const id = readString(question.id);
        return {
          ...(id ? { id } : {}),
          header: title,
          question: readString(question.prompt),
          multiSelect: readBoolean(question.allowMultiple),
          options: readCursorQuestionOptions(question.options),
        };
      })
      .filter((question) => question.question.length > 0),
  };
}

function isApprovedDecision(decision: PermissionDecision): boolean {
  return decision.decision === 'approved'
    || decision.decision === 'approved_for_session'
    || decision.decision === 'approved_execpolicy_amendment';
}

function readAnswers(decision: PermissionDecision): Readonly<Record<string, readonly string[]>> {
  return decision.answers && typeof decision.answers === 'object' && !Array.isArray(decision.answers)
    ? decision.answers
    : {};
}

function mapAnswersToCursorQuestionIds(params: Record<string, unknown>, decision: PermissionDecision): Record<string, string> {
  const answers = readAnswers(decision);
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const out = Object.create(null) as Record<string, string>;

  for (const rawQuestion of questions) {
    const question = asRecord(rawQuestion) as CursorQuestion | null;
    if (!question) continue;
    const id = readString(question.id);
    const prompt = readString(question.prompt);
    if (!id) continue;
    const answer = answers[id] ?? answers[prompt];
    if (Array.isArray(answer) && answer.length > 0) {
      out[id] = answer.join(', ');
    }
  }

  return out;
}

export function extractCursorPlanMarkdown(params: Record<string, unknown>): string {
  return readString(params.plan) || '# Plan\n\n(Cursor did not supply plan text.)';
}

function buildCursorExitPlanModeInput(params: Record<string, unknown>): Record<string, unknown> {
  return {
    plan: extractCursorPlanMarkdown(params),
    name: readString(params.name),
    overview: readString(params.overview),
    isProject: params.isProject === true,
  };
}

type CursorTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
type CursorTodo = { id?: string; content: string; status: CursorTodoStatus };

function normalizeCursorTodoStatus(value: unknown): CursorTodoStatus {
  const normalized = readString(value);
  if (normalized === 'completed') return 'completed';
  // Cursor's todo status enum carries a 4th value not present in the ACP plan spec.
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'in_progress' || normalized === 'inProgress') return 'in_progress';
  return 'pending';
}

export function buildCursorTodoWriteInput(params: Record<string, unknown>): { todos: CursorTodo[] } {
  const todos = Array.isArray(params.todos) ? params.todos : [];
  return {
    todos: todos
      .map((todo) => asRecord(todo))
      .filter((todo): todo is Record<string, unknown> => Boolean(todo))
      .map((todo) => {
        const content = readString(todo.content) || readString(todo.title);
        if (!content) return null;
        const id = readString(todo.id);
        return {
          ...(id ? { id } : {}),
          content,
          status: normalizeCursorTodoStatus(todo.status),
        };
      })
      .filter((todo): todo is CursorTodo => Boolean(todo)),
  };
}

/**
 * Resolve the structured todo checklist Cursor attaches to a `cursor/create_plan` request.
 * Cursor supplies either a flat `todos` array or `phases[{ name, todos[] }]`. We flatten phases
 * (prefixing each item with its phase name) so the unified TodoWrite/TodoView checklist surfaces
 * the full plan, not just the markdown prose.
 */
export function buildCursorPlanTodos(params: Record<string, unknown>): CursorTodo[] {
  const direct = Array.isArray(params.todos) ? params.todos : [];
  if (direct.length > 0) {
    return buildCursorTodoWriteInput({ todos: direct }).todos;
  }
  const phases = Array.isArray(params.phases) ? params.phases : [];
  const flattened: unknown[] = [];
  for (const rawPhase of phases) {
    const phase = asRecord(rawPhase);
    if (!phase) continue;
    const phaseName = readString(phase.name);
    const phaseTodos = Array.isArray(phase.todos) ? phase.todos : [];
    for (const rawTodo of phaseTodos) {
      const todo = asRecord(rawTodo);
      if (!todo) continue;
      const content = readString(todo.content) || readString(todo.title);
      if (!content) continue;
      flattened.push({ ...todo, content: phaseName ? `[${phaseName}] ${content}` : content });
    }
  }
  return buildCursorTodoWriteInput({ todos: flattened }).todos;
}

/**
 * Merge an incoming todo snapshot onto the previous one by id (used when Cursor sends
 * `cursor/update_todos` with `merge: true`). Incoming entries override by id; new entries are
 * appended; first-seen order is preserved. Entries without an id cannot be matched, so they append.
 */
export function mergeCursorTodos(previous: ReadonlyArray<CursorTodo>, incoming: ReadonlyArray<CursorTodo>): CursorTodo[] {
  const byKey = new Map<string, CursorTodo>();
  const order: string[] = [];
  const remember = (key: string, todo: CursorTodo) => {
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, todo);
  };
  previous.forEach((todo, index) => remember(todo.id ?? `__prev_${index}`, todo));
  incoming.forEach((todo, index) => remember(todo.id ?? `__inc_${index}`, todo));
  return order.map((key) => byKey.get(key)!).filter(Boolean);
}

async function awaitPermissionDecision(
  promise: Promise<PermissionDecision>,
  context: AcpExtensionHandlerContext,
): Promise<PermissionDecision> {
  if (context.signal.aborted) {
    throw context.signal.reason instanceof Error ? context.signal.reason : new Error('Cursor extension request aborted');
  }

  return await new Promise<PermissionDecision>((resolve, reject) => {
    const onAbort = () => {
      reject(context.signal.reason instanceof Error ? context.signal.reason : new Error('Cursor extension request aborted'));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      context.signal.removeEventListener('abort', onAbort);
    });
  });
}

export function buildCursorExtensionHandlers(params: Readonly<{
  permissionHandler: AcpPermissionHandler;
}>): AcpExtensionHandlers {
  const askQuestion = async (
    rawParams: Record<string, unknown>,
    context: AcpExtensionHandlerContext,
  ): Promise<Record<string, unknown>> => {
    const toolCallId = readCursorToolCallId(rawParams, 'cursor-ask');
    const input = buildCursorAskQuestionInput(rawParams);
    const decision = await awaitPermissionDecision(
      params.permissionHandler.handleToolCall(toolCallId, 'AskUserQuestion', input) as Promise<PermissionDecision>,
      context,
    );
    if (!isApprovedDecision(decision)) {
      return { answers: {} };
    }
    return { answers: mapAnswersToCursorQuestionIds(rawParams, decision) };
  };

  // Per-session live todo list, used to honor `cursor/update_todos` `merge: true` snapshots.
  let mergedTodoState: CursorTodo[] | null = null;

  const surfaceTodos = async (
    toolCallId: string,
    todos: ReadonlyArray<CursorTodo>,
    context: AcpExtensionHandlerContext,
  ): Promise<void> => {
    if (todos.length === 0) return;
    await awaitPermissionDecision(
      params.permissionHandler.handleToolCall(toolCallId, 'TodoWrite', { todos: [...todos] }) as Promise<PermissionDecision>,
      context,
    );
  };

  const createPlan = async (
    rawParams: Record<string, unknown>,
    context: AcpExtensionHandlerContext,
  ): Promise<Record<string, unknown>> => {
    const toolCallId = readCursorToolCallId(rawParams, 'cursor-plan');
    // Surface the structured todos/phases through the shared TodoWrite -> TodoView checklist so the
    // plan is more than opaque markdown. ExitPlanMode still carries the prose body for approval.
    const planTodos = buildCursorPlanTodos(rawParams);
    if (planTodos.length > 0) {
      mergedTodoState = planTodos;
      try {
        await surfaceTodos(`${toolCallId}-todos`, planTodos, context);
      } catch (error) {
        logger.debug('[CursorACP] Failed to surface create_plan todos (non-fatal)', {
          error: String((error as Error)?.message ?? error),
        });
      }
    }
    const input = buildCursorExitPlanModeInput(rawParams);
    const decision = await awaitPermissionDecision(
      params.permissionHandler.handleToolCall(toolCallId, 'ExitPlanMode', input) as Promise<PermissionDecision>,
      context,
    );
    return { accepted: isApprovedDecision(decision) };
  };

  const updateTodos = async (
    rawParams: Record<string, unknown>,
    context: AcpExtensionHandlerContext,
  ): Promise<Record<string, unknown>> => {
    const toolCallId = readCursorToolCallId(rawParams, 'cursor-todos');
    const incoming = buildCursorTodoWriteInput(rawParams).todos;
    const shouldMerge = rawParams.merge === true && mergedTodoState !== null;
    const todos = shouldMerge ? mergeCursorTodos(mergedTodoState!, incoming) : incoming;
    mergedTodoState = todos;
    await surfaceTodos(toolCallId, todos, context);
    return {};
  };

  const diagnosticOnly = (method: string) => async (
    rawParams: Record<string, unknown>,
    _context: AcpExtensionHandlerContext,
  ): Promise<void> => {
    logger.debug(`[CursorACP] Received unsupported Cursor extension notification ${method}`, {
      keys: Object.keys(rawParams).sort(),
    });
  };

  return {
    requests: {
      'cursor/ask_question': askQuestion,
      'cursor/create_plan': createPlan,
      'cursor/update_todos': updateTodos,
    },
    notifications: {
      'cursor/update_todos': async (rawParams, context) => {
        await updateTodos(rawParams, context);
      },
      'cursor/task': diagnosticOnly('cursor/task'),
      'cursor/generate_image': diagnosticOnly('cursor/generate_image'),
    },
  };
}
