import type {
  AcpRuntimeExtensionsV1,
  AcpRuntimeExtensionHandlerContextV1,
  AcpRuntimeNotificationHandlerV1,
  AcpRuntimeRequestHandlerV1,
  PluginContextV1,
  SessionPermissionDecisionResultV1,
} from '@happier-dev/plugin-sdk';

import {
  mergeCursorTodos,
  readCursorPlanTodos,
  readCursorTodos,
  writeCursorTodoWorkState,
} from './todos.js';
import type { CursorTodo } from './workState.js';

type CursorQuestion = Readonly<{
  id?: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: readonly Readonly<{
    label: string;
    description: string;
  }>[];
}>;

const APPROVED_DECISIONS = new Set([
  'approved',
  'approved_for_session',
  'approved_execpolicy_amendment',
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function isApprovedDecision(decision: SessionPermissionDecisionResultV1): boolean {
  return APPROVED_DECISIONS.has(decision.decision);
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readQuestionOptions(value: unknown): readonly CursorQuestion['options'][number][] {
  const options = Array.isArray(value) ? value : [];
  const normalized = options
    .map((option) => {
      if (!isRecord(option)) {
        return null;
      }
      const label = readString(option.label);
      return label ? Object.freeze({ label, description: label }) : null;
    })
    .filter((option): option is CursorQuestion['options'][number] => option !== null);
  return Object.freeze(normalized.length > 0
    ? normalized
    : [Object.freeze({ label: 'OK', description: 'Continue' })]);
}

function readAskQuestions(params: unknown): readonly CursorQuestion[] {
  if (!isRecord(params)) {
    return [];
  }
  const header = readString(params.title) ?? 'Question';
  const rawQuestions = Array.isArray(params.questions)
    ? params.questions
    : [
        Object.freeze({
          id: params.id,
          prompt: params.question ?? params.prompt,
          options: params.options,
          allowMultiple: params.allowMultiple,
        }),
      ];
  const questions = rawQuestions
    .map((question) => {
      if (!isRecord(question)) {
        return null;
      }
      const prompt = readString(question.prompt) ?? readString(question.question);
      if (!prompt) {
        return null;
      }
      const id = readString(question.id);
      return Object.freeze({
        ...(id ? { id } : {}),
        header,
        question: prompt,
        multiSelect: readBoolean(question.allowMultiple),
        options: readQuestionOptions(question.options),
      });
    })
    .filter((question): question is CursorQuestion => question !== null);
  return Object.freeze(questions);
}

function readDecisionAnswers(decision: SessionPermissionDecisionResultV1): Readonly<Record<string, string>> {
  const value: unknown = decision;
  if (!isRecord(value) || !isRecord(value.answers)) {
    return Object.freeze({});
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value.answers)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  ));
}

function mapAnswersToCursorQuestionIds(
  extensionParams: unknown,
  decision: SessionPermissionDecisionResultV1,
): Readonly<Record<string, string>> {
  const answers = readDecisionAnswers(decision);
  if (!isRecord(extensionParams) || Object.keys(answers).length === 0) {
    return Object.freeze({});
  }
  const out: Record<string, string> = {};
  const rawQuestions = Array.isArray(extensionParams.questions) ? extensionParams.questions : [];
  for (const rawQuestion of rawQuestions) {
    if (!isRecord(rawQuestion)) {
      continue;
    }
    const id = readString(rawQuestion.id);
    const prompt = readString(rawQuestion.prompt) ?? readString(rawQuestion.question);
    if (!id) {
      continue;
    }
    const answer = answers[id] ?? (prompt ? answers[prompt] : undefined);
    if (answer !== undefined) {
      out[id] = answer;
    }
  }
  return Object.freeze(out);
}

function readPayloadKeys(value: unknown): readonly string[] {
  return Object.freeze(isRecord(value) ? Object.keys(value).sort() : []);
}

function readPlanText(params: unknown): string {
  if (!isRecord(params)) {
    return '';
  }
  return readString(params.text)
    ?? readString(params.plan)
    ?? readString(params.description)
    ?? '';
}

function readPlanTitle(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  return readString(params.title) ?? readString(params.name) ?? undefined;
}

function readPlanName(params: unknown): string | undefined {
  return isRecord(params) ? readString(params.name) ?? undefined : undefined;
}

function readPlanOverview(params: unknown): string | undefined {
  return isRecord(params) ? readString(params.overview) ?? undefined : undefined;
}

function readPlanIsProject(params: unknown): boolean | undefined {
  if (!isRecord(params) || !('isProject' in params)) {
    return undefined;
  }
  return params.isProject === true;
}

type CursorPermissionIdentity = Readonly<{
  requestId?: string;
  toolCallId: string;
}>;

export function createCursorAcpRuntimeExtensions(params: Readonly<{
  ctx: PluginContextV1;
}>): AcpRuntimeExtensionsV1 {
  let currentTodos: readonly CursorTodo[] = Object.freeze([]);
  let fallbackToolCallCounter = 0;

  function createPermissionIdentity(
    context: AcpRuntimeExtensionHandlerContextV1,
    toolName: string,
  ): CursorPermissionIdentity {
    const requestId = readString(context.requestId);
    const suffix = requestId ?? String(++fallbackToolCallCounter);
    return Object.freeze({
      ...(requestId ? { requestId } : {}),
      toolCallId: `cursor:${context.method}:${toolName}:${suffix}`,
    });
  }

  async function handleUpdateTodos(extensionParams: unknown): Promise<void> {
    const nextTodos = readCursorTodos(extensionParams);
    if (!nextTodos) {
      params.ctx.logger.debug('Cursor ACP update_todos ignored malformed payload', {
        keys: readPayloadKeys(extensionParams),
      });
      return;
    }
    currentTodos = isRecord(extensionParams) && readBoolean(extensionParams.merge)
      ? mergeCursorTodos(currentTodos, nextTodos)
      : nextTodos;
    await writeCursorTodoWorkState({
      ctx: params.ctx,
      todos: currentTodos,
    });
  }

  const askQuestion: AcpRuntimeRequestHandlerV1 = async (
    extensionParams: unknown,
    context: AcpRuntimeExtensionHandlerContextV1,
  ) => {
    const input = { questions: readAskQuestions(extensionParams) };
    const decision = await params.ctx.session.permissions.requestDecision({
      provider: 'cursor',
      ...createPermissionIdentity(context, 'AskUserQuestion'),
      toolName: 'AskUserQuestion',
      input,
    }, {
      signal: context.signal,
    });
    return isApprovedDecision(decision)
      ? { answers: mapAnswersToCursorQuestionIds(extensionParams, decision) }
      : { answers: {} };
  };

  const createPlan: AcpRuntimeRequestHandlerV1 = async (
    extensionParams: unknown,
    context: AcpRuntimeExtensionHandlerContextV1,
  ) => {
    const todos = readCursorPlanTodos(extensionParams);
    if (todos.length > 0) {
      currentTodos = todos;
      try {
        await writeCursorTodoWorkState({
          ctx: params.ctx,
          todos,
        });
      } catch (error) {
        params.ctx.logger.debug('Cursor ACP create_plan todo surfacing failed; continuing with plan approval', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const title = readPlanTitle(extensionParams);
    const name = readPlanName(extensionParams);
    const overview = readPlanOverview(extensionParams);
    const isProject = readPlanIsProject(extensionParams);
    const decision = await params.ctx.session.permissions.requestDecision({
      provider: 'cursor',
      ...createPermissionIdentity(context, 'ExitPlanMode'),
      toolName: 'ExitPlanMode',
      input: {
        ...(title ? { title } : {}),
        ...(name ? { name } : {}),
        ...(overview ? { overview } : {}),
        ...(isProject !== undefined ? { isProject } : {}),
        plan: readPlanText(extensionParams),
      },
    }, {
      signal: context.signal,
    });
    return {
      accepted: isApprovedDecision(decision),
    };
  };

  const updateTodos: AcpRuntimeRequestHandlerV1 = async (
    extensionParams: unknown,
  ) => {
    await handleUpdateTodos(extensionParams);
    return {};
  };

  const taskDiagnostic: AcpRuntimeRequestHandlerV1 = async (extensionParams: unknown) => {
    params.ctx.logger.debug('Cursor ACP task extension is diagnostic-only in V1', {
      keys: readPayloadKeys(extensionParams),
    });
    return {};
  };

  const imageDiagnostic: AcpRuntimeRequestHandlerV1 = async (extensionParams: unknown) => {
    params.ctx.logger.debug('Cursor ACP image generation extension is diagnostic-only in V1', {
      keys: readPayloadKeys(extensionParams),
    });
    return {};
  };

  const updateTodosNotification: AcpRuntimeNotificationHandlerV1 = async (
    extensionParams: unknown,
  ) => {
    await handleUpdateTodos(extensionParams);
  };

  const taskDiagnosticNotification: AcpRuntimeNotificationHandlerV1 = async (extensionParams: unknown) => {
    params.ctx.logger.debug('Cursor ACP task notification is diagnostic-only in V1', {
      keys: readPayloadKeys(extensionParams),
    });
  };

  const imageDiagnosticNotification: AcpRuntimeNotificationHandlerV1 = async (extensionParams: unknown) => {
    params.ctx.logger.debug('Cursor ACP image generation notification is diagnostic-only in V1', {
      keys: readPayloadKeys(extensionParams),
    });
  };

  return Object.freeze({
    requests: Object.freeze({
      'cursor/ask_question': askQuestion,
      'cursor/create_plan': createPlan,
      'cursor/update_todos': updateTodos,
      'cursor/task': taskDiagnostic,
      'cursor/generate_image': imageDiagnostic,
    }),
    notifications: Object.freeze({
      'cursor/update_todos': updateTodosNotification,
      'cursor/task': taskDiagnosticNotification,
      'cursor/generate_image': imageDiagnosticNotification,
    }),
  });
}
