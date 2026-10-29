import { createHash, randomUUID } from 'node:crypto';

import type {
  JsonValue,
} from '@happier-dev/plugin-sdk';
import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  InteractionTransientAuthorRequestV1Schema,
  type InteractionOptions,
  type InteractionTransientAuthorQuestionV1,
  type InteractionTransientApprovalResultV1,
  type InteractionTransientQuestionAnswerV1,
  type InteractionTransientQuestionsAuthorRequestV1,
} from '@happier-dev/plugin-sdk/interactions';

import type { DisposableCodexAppServerClient } from './client.js';
import { projectCodexAppServerToolEventsFromNotification } from './projection/toolEvents.js';
import {
  buildCodexAsyncUserInputReply,
  buildCodexRequestUserInputAnswers,
  looksLikeCodexApprovalRequestUserInput,
  readCodexAsyncUserInputItem,
  resolveCodexApprovalQuestionChoice,
  type CodexApprovalOutcome,
} from '../core/requestUserInputQuestions.js';

type InteractionUi = Pick<AgentSessionRuntimeContext['services']['interactions'], 'requestApproval' | 'askQuestions'>;
type SessionMcp = Pick<
  NonNullable<AgentSessionRuntimeContext['services']['sessions']['current']>['mcp'],
  'elicit'
>;
type AsyncQuestionMessageSender = (request: Readonly<{
  idempotencyKey: string;
  text: string;
  toolCallId: string;
}>) => Promise<void>;
type RecordLike = Readonly<Record<string, unknown>>;

function readRecord(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordLike
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toJsonValue(value: unknown): JsonValue {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function matchesCurrentThread(
  value: unknown,
  getThreadId: () => string | null,
): value is RecordLike {
  const record = readRecord(value);
  const currentThreadId = getThreadId();
  return Boolean(
    record
    && currentThreadId
    && readString(record.threadId) === currentThreadId,
  );
}

function readCommandApprovalAvailability(record: RecordLike): Readonly<{
  accept: boolean;
  acceptForSession: boolean;
}> {
  if (!Array.isArray(record.availableDecisions)) {
    return { accept: true, acceptForSession: true };
  }
  return {
    accept: record.availableDecisions.includes('accept'),
    acceptForSession: record.availableDecisions.includes('acceptForSession'),
  };
}

function mapApprovalDecision(
  result: InteractionTransientApprovalResultV1,
  options?: Readonly<{
    allowAccept?: boolean;
    allowSessionPersistence?: boolean;
  }>,
): 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
  if (result.status === 'approved') {
    if (result.persistence === 'session') {
      if (options?.allowSessionPersistence !== false) return 'acceptForSession';
      return 'decline';
    }
    return options?.allowAccept !== false ? 'accept' : 'decline';
  }
  return result.status !== 'declined' && result.status !== 'unavailable' ? 'cancel' : 'decline';
}

async function requestApproval(
  ui: InteractionUi | undefined,
  input: Readonly<{
    title: string;
    description?: string;
    toolName: string;
    toolCallId?: string | null;
    params: unknown;
    allowSessionPersistence?: boolean;
  }>,
  signal?: AbortSignal,
): Promise<InteractionTransientApprovalResultV1> {
  if (!ui) {
    return {
      requestId: randomUUID(),
      kind: 'approval',
      status: 'unavailable',
    };
  }
  try {
    return await ui.requestApproval({
      kind: 'approval',
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      subject: {
        kind: 'tool',
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        name: input.toolName,
        input: toJsonValue(input.params),
      },
      ...(input.allowSessionPersistence === undefined
        ? {}
        : { allowSessionPersistence: input.allowSessionPersistence }),
    }, { signal });
  } catch {
    return {
      requestId: randomUUID(),
      kind: 'approval',
      status: 'unavailable',
    };
  }
}

type CodexQuestion = Readonly<{
  id: string;
  prompt: string;
  options: readonly Readonly<{ value: string; label: string; description?: string }>[];
  allowCustom: boolean;
  required: boolean;
  multiple: boolean;
}>;

function readChoiceOptions(value: unknown): CodexQuestion['options'] {
  if (!Array.isArray(value)) return [];
  const options: Array<{
    value: string;
    label: string;
    description?: string;
  }> = [];
  for (const raw of value) {
    if (typeof raw === 'string') {
      if (raw.trim()) options.push({ value: raw, label: raw });
      continue;
    }
    const record = readRecord(raw);
    const value = readString(record?.const) ?? readString(record?.label);
    if (!value) continue;
    const label = readString(record?.title) ?? readString(record?.label) ?? value;
    const description = readString(record?.description);
    options.push({
      value,
      label,
      ...(description ? { description } : {}),
    });
  }
  return options;
}

function toPluginQuestion(question: CodexQuestion): InteractionTransientAuthorQuestionV1 {
  if (question.options.length === 0) {
    return {
      id: question.id,
      prompt: question.prompt,
      type: 'text',
      required: question.required,
    };
  }
  const choices = question.options.map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  })) as [
    { id: string; label: string; description?: string },
    ...Array<{ id: string; label: string; description?: string }>,
  ];
  return {
    id: question.id,
    prompt: question.prompt,
    type: question.multiple ? 'multipleChoice' : 'singleChoice',
    required: question.required,
    choices,
    ...(question.allowCustom ? { allowCustom: true } : {}),
  };
}

function readAnswerValues(answer: InteractionTransientQuestionAnswerV1 | undefined): string[] {
  if (!answer) return [];
  if (answer.kind === 'text') return [answer.value];
  if (answer.kind === 'singleChoice') {
    return [answer.answer.kind === 'choice' ? answer.answer.choiceId : answer.answer.value];
  }
  return answer.answers.map((entry) => (
    entry.kind === 'choice' ? entry.choiceId : entry.value
  ));
}

function normalizeToolQuestions(value: unknown): CodexQuestion[] {
  if (!Array.isArray(value)) return [];
  const output: CodexQuestion[] = [];
  for (const raw of value) {
    const record = readRecord(raw);
    const id = readString(record?.id);
    const prompt = readString(record?.question) ?? readString(record?.header);
    if (!id || !prompt) continue;
    output.push({
      id,
      prompt,
      options: readChoiceOptions(record?.options),
      allowCustom: record?.isOther === true,
      required: true,
      multiple: false,
    });
  }
  return output;
}

function normalizeAsyncQuestions(
  item: NonNullable<ReturnType<typeof readCodexAsyncUserInputItem>>,
): CodexQuestion[] {
  return item.questions.map((question) => ({
    id: `async-question-${question.index}`,
    prompt: question.title,
    options: question.options.map((option) => ({ value: option, label: option })),
    allowCustom: question.options.length > 0,
    required: true,
    multiple: false,
  }));
}

function buildQuestionsRequest(
  questions: readonly CodexQuestion[],
  title: string,
): InteractionTransientQuestionsAuthorRequestV1 | null {
  if (questions.length === 0) return null;
  const pluginQuestions = questions.map(toPluginQuestion) as [
    InteractionTransientAuthorQuestionV1,
    ...InteractionTransientAuthorQuestionV1[],
  ];
  const parsed = InteractionTransientAuthorRequestV1Schema.safeParse({
    kind: 'questions',
    title,
    questions: pluginQuestions,
  });
  return parsed.success && parsed.data.kind === 'questions' ? parsed.data : null;
}

async function askQuestionsRequest(
  ui: InteractionUi,
  request: InteractionTransientQuestionsAuthorRequestV1,
  signal?: AbortSignal,
  lifetime?: InteractionOptions['lifetime'],
): Promise<Readonly<Record<string, InteractionTransientQuestionAnswerV1>> | null> {
  const result = await ui.askQuestions(request, { signal, ...(lifetime ? { lifetime } : {}) });
  return result.status === 'answered' ? result.answers : null;
}

async function askQuestions(
  ui: InteractionUi | undefined,
  questions: readonly CodexQuestion[],
  title: string,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, InteractionTransientQuestionAnswerV1>> | null> {
  if (!ui) return null;
  const request = buildQuestionsRequest(questions, title);
  if (!request) return null;
  try {
    return await askQuestionsRequest(ui, request, signal);
  } catch {
    return null;
  }
}

function approvalOutcome(result: InteractionTransientApprovalResultV1): CodexApprovalOutcome {
  if (result.status === 'approved') {
    return result.persistence === 'session' ? 'approve_for_session' : 'approve_once';
  }
  return result.status === 'declined' || result.status === 'unavailable' ? 'deny' : 'cancel';
}

export function registerCodexAppServerInteractionHandlers(params: Readonly<{
  client: DisposableCodexAppServerClient;
  ui?: InteractionUi;
  mcp?: SessionMcp;
  sendUserMessage?: AsyncQuestionMessageSender;
  onAsyncQuestionDeliveryError?: (error: unknown) => void;
  getThreadId(): string | null;
  mcpServerKeys?: ReadonlyMap<string, string>;
}>): (raw: unknown) => boolean {
  type RequestMessage = Readonly<{ id?: unknown }>;
  type TrackedRequestHandler = (
    raw: RecordLike,
    signal: AbortSignal | undefined,
    message: RequestMessage,
  ) => Promise<unknown>;
  const pendingRequests = new Map<string, AbortController>();
  const handledAsyncQuestionItemIds = new Set<string>();
  const approvalSubjectsByItem = new Map<string, Readonly<{ name: string; input: unknown }>>();
  const toolItemKey = (raw: RecordLike, itemId: string | null): string | null => {
    const threadId = readString(raw.threadId);
    const turnId = readString(raw.turnId);
    return threadId && turnId && itemId ? JSON.stringify([threadId, turnId, itemId]) : null;
  };
  const rememberApprovalSubject = (
    method: 'item/started' | 'item/completed',
    raw: RecordLike,
    notificationParams: unknown = raw,
  ): void => {
    for (const event of projectCodexAppServerToolEventsFromNotification({
      method,
      notificationParams,
      mcpServerKeys: params.mcpServerKeys,
    })) {
      const key = toolItemKey(raw, event.callId);
      if (!key) continue;
      if (method === 'item/completed') {
        approvalSubjectsByItem.delete(key);
        continue;
      }
      if (event.type !== 'tool-call') continue;
      const isMcpTool = event.name.startsWith('mcp__');
      if (!isMcpTool && event.name !== 'Patch') continue;
      if (
        isMcpTool
        && params.mcpServerKeys
        && ![...params.mcpServerKeys.keys()].some(server => event.name.startsWith(`mcp__${server}__`))
      ) continue;
      approvalSubjectsByItem.set(key, { name: event.name, input: event.input });
    }
  };
  // Approval requests carry only item identity. Admit their preceding native
  // lifecycle facts before queued domain callbacks, using the same projector.
  const stopTrackingApprovalSubjects = params.client.onNativeEvent((method, raw) => {
    if (!matchesCurrentThread(raw, params.getThreadId)) return;
    const record = readRecord(raw);
    if (method === 'item/started' || method === 'item/completed') {
      rememberApprovalSubject(method, record ?? {}, raw);
    } else if (method === 'item/fileChange/patchUpdated') {
      const itemId = readString(record?.itemId);
      if (!record || !itemId) return;
      rememberApprovalSubject('item/started', record, {
        ...record,
        item: { id: itemId, type: 'fileChange', changes: record.changes },
      });
    } else if (method === 'turn/completed') {
      approvalSubjectsByItem.clear();
    }
  });
  params.client.onExit(() => {
    stopTrackingApprovalSubjects();
    approvalSubjectsByItem.clear();
  });
  const requestKey = (value: unknown): string | null => (
    typeof value === 'string' || typeof value === 'number'
      ? `${typeof value}:${String(value)}`
      : null
  );
  const registerTrackedRequestHandler = (method: string, handler: TrackedRequestHandler): void => {
    params.client.registerRequestHandler(method, async (raw, message) => {
      const request = readRecord(raw) ?? {};
      const key = requestKey(message.id);
      if (!key) return await handler(request, undefined, message);
      const controller = new AbortController();
      pendingRequests.set(key, controller);
      try {
        return await handler(request, controller.signal, message);
      } finally {
        if (pendingRequests.get(key) === controller) pendingRequests.delete(key);
      }
    });
  };

  params.client.registerNotificationHandler('serverRequest/resolved', (raw) => {
    if (!matchesCurrentThread(raw, params.getThreadId)) return;
    const key = requestKey(readRecord(raw)?.requestId);
    if (!key) return;
    const controller = pendingRequests.get(key);
    if (!controller) return;
    pendingRequests.delete(key);
    controller.abort();
  });

  const handleAsyncQuestionNotification = (raw: unknown): boolean => {
    const ui = params.ui;
    const sendUserMessage = params.sendUserMessage;
    if (!ui || !sendUserMessage || !matchesCurrentThread(raw, params.getThreadId)) return false;
    const item = readCodexAsyncUserInputItem(raw);
    if (!item) return false;
    const request = buildQuestionsRequest(normalizeAsyncQuestions(item), 'Codex has questions');
    if (!request) return false;
    if (handledAsyncQuestionItemIds.has(item.itemId)) return true;
    handledAsyncQuestionItemIds.add(item.itemId);
    void (async () => {
      const answers = await askQuestionsRequest(ui, request, undefined, 'occurrence');
      if (!answers) return;
      const answersByKey: Record<string, readonly string[]> = Object.create(null);
      for (const [key, answer] of Object.entries(answers)) {
        answersByKey[key] = readAnswerValues(answer);
      }
      const text = buildCodexAsyncUserInputReply({ item, answersByKey });
      if (!text) return;
      const digest = createHash('sha256').update(item.itemId).digest('hex').slice(0, 32);
      await sendUserMessage({
        idempotencyKey: `codex-async-question:${digest}`,
        text,
        toolCallId: item.itemId,
      });
    })().catch((error: unknown) => {
      params.onAsyncQuestionDeliveryError?.(error);
    });
    return true;
  };

  registerTrackedRequestHandler(
    'item/commandExecution/requestApproval',
    async (raw, signal) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) return { decision: 'decline' };
      const availability = readCommandApprovalAvailability(raw);
      if (!availability.accept && !availability.acceptForSession) {
        return { decision: 'decline' };
      }
      const reason = readString(raw.reason);
      const command = readString(raw.command);
      const cwd = readString(raw.cwd);
      const result = await requestApproval(params.ui, {
        title: 'Allow Codex command execution?',
        ...(reason ? { description: reason } : {}),
        toolName: 'Bash',
        toolCallId: readString(raw.itemId),
        params: {
          ...(command ? { command } : {}),
          ...(cwd ? { cwd } : {}),
          ...(reason ? { reason } : {}),
        },
        allowSessionPersistence: availability.acceptForSession,
      }, signal);
      return {
        decision: mapApprovalDecision(result, {
          allowAccept: availability.accept,
          allowSessionPersistence: availability.acceptForSession,
        }),
      };
    },
  );

  registerTrackedRequestHandler(
    'item/fileChange/requestApproval',
    async (raw, signal) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) return { decision: 'decline' };
      const reason = readString(raw.reason);
      const grantRoot = readString(raw.grantRoot);
      const itemKey = toolItemKey(raw, readString(raw.itemId));
      const subjectInput = readRecord(itemKey ? approvalSubjectsByItem.get(itemKey)?.input : null) ?? {};
      const result = await requestApproval(params.ui, {
        title: 'Allow Codex file changes?',
        ...(reason ? { description: reason } : {}),
        toolName: 'Patch',
        toolCallId: readString(raw.itemId),
        params: {
          ...subjectInput,
          ...(grantRoot ? { grantRoot } : {}),
          ...(reason ? { reason } : {}),
        },
        allowSessionPersistence: true,
      }, signal);
      return { decision: mapApprovalDecision(result) };
    },
  );

  registerTrackedRequestHandler(
    'item/permissions/requestApproval',
    async (raw, signal) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) {
        return { permissions: {}, scope: 'turn' };
      }
      const result = await requestApproval(params.ui, {
        title: 'Allow additional Codex permissions?',
        ...(readString(raw.reason) ? { description: readString(raw.reason)! } : {}),
        toolName: 'codex_permissions',
        params: raw,
        allowSessionPersistence: true,
      }, signal);
      if (result.status !== 'approved') {
        return { permissions: {}, scope: 'turn' };
      }
      const requestedPermissions = readRecord(raw.permissions);
      const permissions = {
        ...(requestedPermissions?.network
          ? { network: toJsonValue(requestedPermissions.network) }
          : {}),
        ...(requestedPermissions?.fileSystem
          ? { fileSystem: toJsonValue(requestedPermissions.fileSystem) }
          : {}),
      };
      return {
        permissions,
        scope: result.persistence === 'session' ? 'session' : 'turn',
      };
    },
  );

  registerTrackedRequestHandler(
    'item/tool/requestUserInput',
    async (raw, signal) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) return { answers: {} };
      const questions = normalizeToolQuestions(raw.questions);
      if (questions.length === 0) return { answers: {} };
      if (looksLikeCodexApprovalRequestUserInput({
        toolName: 'codex_app_server_tool',
        questions: raw.questions,
      })) {
        const itemKey = toolItemKey(raw, readString(raw.itemId));
        const subject = itemKey ? approvalSubjectsByItem.get(itemKey) : undefined;
        const result = await requestApproval(params.ui, {
          title: 'Codex needs your approval',
          toolName: subject?.name ?? `codex_request_user_input_approval:${randomUUID()}`,
          ...(subject ? { toolCallId: readString(raw.itemId) } : {}),
          params: subject ? subject.input : raw,
          allowSessionPersistence: true,
        }, signal);
        const choice = resolveCodexApprovalQuestionChoice({
          questions: raw.questions,
          outcome: approvalOutcome(result),
          // Session persistence belongs to the host's grant owner. A native
          // MCP grant skips future policy lookups and cannot honor live Off.
          allowSessionPersistence: false,
        });
        return choice
          ? { answers: { [choice.questionId]: { answers: [choice.label] } } }
          : { answers: {} };
      }
      const answers = await askQuestions(params.ui, questions, 'Codex question', signal);
      if (!answers) return { answers: {} };
      return {
        answers: buildCodexRequestUserInputAnswers({
          questions: raw.questions,
          answersByKey: Object.fromEntries(questions.flatMap((question) => {
            const values = readAnswerValues(answers[question.id]);
            return values.length > 0
              ? [[question.id, values.join(', ')]] as const
              : [];
          })),
        }),
      };
    },
  );

  registerTrackedRequestHandler(
    'mcpServer/elicitation/request',
    async (raw, signal, message) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) {
        return { action: 'decline', content: null, _meta: null };
      }
      const mode = readString(raw.mode);
      const serverName = readString(raw.serverName) ?? 'MCP server';
      const isFormMode = mode === 'form' || mode === 'openai/form';
      if (isFormMode && raw.requestedSchema === undefined) {
        return { action: 'cancel', content: null, _meta: null };
      }
      if (!params.mcp) return { action: 'cancel', content: null, _meta: null };
      const requestId = typeof message.id === 'string' || typeof message.id === 'number'
        ? String(message.id)
        : undefined;
      try {
        const result = await params.mcp.elicit({
          ...(requestId ? { requestId } : {}),
          serverName,
          toolName: 'elicitation',
          input: raw,
          ...(readString(raw.message) ? { prompt: readString(raw.message)! } : {}),
          ...(isFormMode
            ? { schema: raw.requestedSchema }
            : {}),
        }, { signal });
        if (result.status === 'accepted') {
          return {
            action: 'accept',
            content: mode === 'url' ? null : result.content ?? {},
            _meta: null,
          };
        }
        if (result.status === 'declined') {
          return { action: 'decline', content: null, _meta: null };
        }
        return {
          action: 'cancel',
          content: null,
          _meta: null,
        };
      } catch {
        return { action: 'cancel', content: null, _meta: null };
      }
    },
  );

  return handleAsyncQuestionNotification;
}
