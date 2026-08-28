import { randomUUID } from 'node:crypto';

import type {
  JsonValue,
} from '@happier-dev/plugin-sdk';
import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  InteractionTransientAuthorQuestionV1,
  InteractionTransientApprovalResultV1,
  InteractionTransientQuestionAnswerV1,
} from '@happier-dev/plugin-sdk/interactions';

import type { DisposableCodexAppServerClient } from './client.js';
import {
  buildCodexRequestUserInputAnswers,
  looksLikeCodexApprovalRequestUserInput,
  resolveCodexApprovalQuestionChoice,
  type CodexApprovalOutcome,
} from '../core/requestUserInputQuestions.js';

type InteractionUi = Pick<AgentSessionRuntimeContext['services']['interactions'], 'requestApproval' | 'askQuestions'>;
type SessionMcp = Pick<
  NonNullable<AgentSessionRuntimeContext['services']['sessions']['current']>['mcp'],
  'elicit'
>;
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
    params: unknown;
    allowSessionPersistence?: boolean;
  }>,
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
        name: input.toolName,
        input: toJsonValue(input.params),
      },
      ...(input.allowSessionPersistence === undefined
        ? {}
        : { allowSessionPersistence: input.allowSessionPersistence }),
    });
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

async function askQuestions(
  ui: InteractionUi | undefined,
  questions: readonly CodexQuestion[],
  title: string,
): Promise<Readonly<Record<string, InteractionTransientQuestionAnswerV1>> | null> {
  if (!ui || questions.length === 0) return null;
  const pluginQuestions = questions.map(toPluginQuestion) as [
    InteractionTransientAuthorQuestionV1,
    ...InteractionTransientAuthorQuestionV1[],
  ];
  try {
    const result = await ui.askQuestions({
      kind: 'questions',
      title,
      questions: pluginQuestions,
    });
    return result.status === 'answered' ? result.answers : null;
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
  getThreadId(): string | null;
}>): void {
  params.client.registerRequestHandler(
    'item/commandExecution/requestApproval',
    async (raw) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) return { decision: 'decline' };
      const availability = readCommandApprovalAvailability(raw);
      if (!availability.accept && !availability.acceptForSession) {
        return { decision: 'decline' };
      }
      const result = await requestApproval(params.ui, {
        title: 'Allow Codex command execution?',
        ...(readString(raw.reason) ? { description: readString(raw.reason)! } : {}),
        toolName: 'codex_command_execution',
        params: raw,
        allowSessionPersistence: availability.acceptForSession,
      });
      return {
        decision: mapApprovalDecision(result, {
          allowAccept: availability.accept,
          allowSessionPersistence: availability.acceptForSession,
        }),
      };
    },
  );

  params.client.registerRequestHandler(
    'item/fileChange/requestApproval',
    async (raw) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) return { decision: 'decline' };
      const result = await requestApproval(params.ui, {
        title: 'Allow Codex file changes?',
        ...(readString(raw.reason) ? { description: readString(raw.reason)! } : {}),
        toolName: 'codex_file_change',
        params: raw,
        allowSessionPersistence: true,
      });
      return { decision: mapApprovalDecision(result) };
    },
  );

  params.client.registerRequestHandler(
    'item/permissions/requestApproval',
    async (raw) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) {
        return { permissions: {}, scope: 'turn' };
      }
      const result = await requestApproval(params.ui, {
        title: 'Allow additional Codex permissions?',
        ...(readString(raw.reason) ? { description: readString(raw.reason)! } : {}),
        toolName: 'codex_permissions',
        params: raw,
        allowSessionPersistence: true,
      });
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

  params.client.registerRequestHandler(
    'item/tool/requestUserInput',
    async (raw) => {
      if (!matchesCurrentThread(raw, params.getThreadId)) return { answers: {} };
      const questions = normalizeToolQuestions(raw.questions);
      if (questions.length === 0) return { answers: {} };
      if (looksLikeCodexApprovalRequestUserInput({
        toolName: 'codex_app_server_tool',
        questions: raw.questions,
      })) {
        const result = await requestApproval(params.ui, {
          title: 'Codex needs your approval',
          toolName: 'codex_request_user_input_approval',
          params: raw,
          allowSessionPersistence: true,
        });
        const choice = resolveCodexApprovalQuestionChoice({
          questions: raw.questions,
          outcome: approvalOutcome(result),
        });
        return choice
          ? { answers: { [choice.questionId]: { answers: [choice.label] } } }
          : { answers: {} };
      }
      const answers = await askQuestions(params.ui, questions, 'Codex question');
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

  params.client.registerRequestHandler(
    'mcpServer/elicitation/request',
    async (raw, message) => {
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
        });
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
}
