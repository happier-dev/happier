import type {
  JsonValue,
} from '@happier-dev/plugin-sdk';
import {
  AgentRuntimeJsonValueSchema,
  type AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';

import type { DisposableCodexAppServerClient } from './client.js';
import {
  buildCodexRequestUserInputAnswers,
  looksLikeCodexApprovalRequestUserInput,
} from '../core/requestUserInputQuestions.js';

type InteractionUi = Pick<AgentRuntimeContext['ui'], 'requestApproval' | 'askQuestions'>;
type PluginUiApprovalResult = Awaited<ReturnType<InteractionUi['requestApproval']>>;
type PluginUiQuestion = Parameters<InteractionUi['askQuestions']>[0][number];
type PluginUiQuestionsResult = Awaited<ReturnType<InteractionUi['askQuestions']>>;
type PluginUiQuestionAnswer = Extract<
  PluginUiQuestionsResult,
  Readonly<{ status: 'answered' }>
>['answers'][string];
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
  result: PluginUiApprovalResult,
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
  return result.status === 'cancelled' ? 'cancel' : 'decline';
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
): Promise<PluginUiApprovalResult> {
  if (!ui) {
    return {
      status: 'unavailable',
      diagnostic: {
        code: 'codex_app_server_interaction_unavailable',
        severity: 'error',
        message: 'Codex app-server interaction UI is unavailable.',
      },
    };
  }
  try {
    return await ui.requestApproval({
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
      status: 'unavailable',
      diagnostic: {
        code: 'codex_app_server_interaction_failed',
        severity: 'error',
        message: 'Codex app-server interaction UI failed.',
      },
    };
  }
}

type CodexQuestion = Readonly<{
  id: string;
  prompt: string;
  options: readonly Readonly<{ value: string; label: string; description?: string }>[];
  allowCustom: boolean;
  required: boolean;
  valueType: 'string' | 'number' | 'integer' | 'boolean';
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

function toPluginQuestion(question: CodexQuestion): PluginUiQuestion {
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
    type: question.multiple ? 'multiple' : 'single',
    required: question.required,
    choices,
    ...(question.allowCustom ? { allowCustom: true } : {}),
  };
}

function readAnswerValues(answer: PluginUiQuestionAnswer | undefined): string[] {
  if (!answer) return [];
  if (answer.type === 'text') return [answer.value];
  if (answer.type === 'single') {
    return [answer.answer.type === 'choice' ? answer.answer.choiceId : answer.answer.value];
  }
  return answer.answers.map((entry) => (
    entry.type === 'choice' ? entry.choiceId : entry.value
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
      valueType: 'string',
      multiple: false,
    });
  }
  return output;
}

function readSchemaOptions(schema: RecordLike): CodexQuestion['options'] {
  const direct = readChoiceOptions(schema.enum);
  if (direct.length > 0) {
    const enumNames = schema.enumNames;
    if (
      Array.isArray(enumNames)
      && enumNames.length === direct.length
    ) {
      return direct.map((option, index) => ({
        ...option,
        label: readString(enumNames[index]) ?? option.label,
      }));
    }
    return direct;
  }
  const oneOf = readChoiceOptions(schema.oneOf);
  if (oneOf.length > 0) return oneOf;
  const items = readRecord(schema.items);
  if (!items) return [];
  const itemEnum = readChoiceOptions(items.enum);
  return itemEnum.length > 0 ? itemEnum : readChoiceOptions(items.anyOf);
}

function normalizeMcpFormQuestions(schemaValue: unknown): CodexQuestion[] {
  const schema = readRecord(schemaValue);
  const properties = readRecord(schema?.properties);
  if (schema?.type !== 'object' || !properties) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.map(readString).filter((value): value is string => value !== null)
      : [],
  );
  const output: CodexQuestion[] = [];
  for (const [id, rawProperty] of Object.entries(properties)) {
    const property = readRecord(rawProperty);
    if (!property) continue;
    const type = property.type === 'number'
      || property.type === 'integer'
      || property.type === 'boolean'
      ? property.type
      : 'string';
    const multiple = property.type === 'array';
    const options = type === 'boolean'
      ? [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]
      : readSchemaOptions(property);
    output.push({
      id,
      prompt: readString(property.title) ?? readString(property.description) ?? id,
      options,
      allowCustom: false,
      required: required.has(id),
      valueType: type,
      multiple,
    });
  }
  return output;
}

function answerValue(question: CodexQuestion, values: string[]): JsonValue | undefined {
  if (values.length === 0) return undefined;
  if (question.multiple) return values;
  const value = values[0]!;
  if (question.valueType === 'boolean') {
    return value === 'true' ? true : value === 'false' ? false : undefined;
  }
  if (question.valueType === 'number' || question.valueType === 'integer') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    if (question.valueType === 'integer' && !Number.isInteger(parsed)) return undefined;
    return parsed;
  }
  return value;
}

async function askQuestions(
  ui: InteractionUi | undefined,
  questions: readonly CodexQuestion[],
  title: string,
): Promise<Readonly<Record<string, PluginUiQuestionAnswer>> | null> {
  if (!ui || questions.length === 0) return null;
  const pluginQuestions = questions.map(toPluginQuestion) as [
    PluginUiQuestion,
    ...PluginUiQuestion[],
  ];
  try {
    const result = await ui.askQuestions(pluginQuestions, { title });
    return result.status === 'answered' ? result.answers : null;
  } catch {
    return null;
  }
}

function chooseApprovalLabel(
  questions: readonly CodexQuestion[],
  result: PluginUiApprovalResult,
): string | null {
  const labels = questions.flatMap((question) => question.options.map((option) => option.value));
  const pick = (pattern: RegExp) => labels.find((label) => pattern.test(label)) ?? null;
  if (result.status === 'approved') {
    return pick(/\bapprove\b|\ballow\b|\baccept\b/i) ?? labels[0] ?? null;
  }
  if (result.status === 'cancelled') {
    return pick(/\bcancel\b|\babort\b|\bstop\b/i)
      ?? pick(/\bdeny\b|\breject\b|\bdecline\b/i)
      ?? labels.at(-1)
      ?? null;
  }
  return pick(/\bdeny\b|\breject\b|\bdecline\b/i) ?? labels.at(-1) ?? null;
}

export function registerCodexAppServerInteractionHandlers(params: Readonly<{
  client: DisposableCodexAppServerClient;
  ui?: InteractionUi;
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
        const choice = chooseApprovalLabel(questions, result);
        return choice
          ? { answers: { [questions[0]!.id]: { answers: [choice] } } }
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
      const formQuestions = mode === 'form' || mode === 'openai/form'
        ? normalizeMcpFormQuestions(raw.requestedSchema)
        : [];
      if (formQuestions.length > 0) {
        const answers = await askQuestions(
          params.ui,
          formQuestions,
          readString(raw.message) ?? `${serverName} request`,
        );
        if (!answers) return { action: 'cancel', content: null, _meta: null };
        const content: Record<string, JsonValue> = {};
        for (const question of formQuestions) {
          const value = answerValue(question, readAnswerValues(answers[question.id]));
          if (value !== undefined) content[question.id] = value;
        }
        if (formQuestions.some((question) => (
          question.required && !Object.prototype.hasOwnProperty.call(content, question.id)
        ))) {
          return { action: 'cancel', content: null, _meta: null };
        }
        return { action: 'accept', content, _meta: null };
      }
      const result = await requestApproval(params.ui, {
        title: `${serverName} is requesting input`,
        ...(readString(raw.message) ? { description: readString(raw.message)! } : {}),
        toolName: `mcp__${serverName}__elicitation`,
        params: {
          ...raw,
          requestId: message.id ?? null,
        },
        allowSessionPersistence: false,
      });
      if (result.status === 'approved') {
        return {
          action: 'accept',
          content: mode === 'url' ? null : {},
          _meta: null,
        };
      }
      return {
        action: result.status === 'cancelled' ? 'cancel' : 'decline',
        content: null,
        _meta: null,
      };
    },
  );
}
