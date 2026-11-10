import { randomUUID } from 'node:crypto';
import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  InteractionTransientAuthorQuestionV1,
  InteractionTransientQuestionAnswerV1,
} from '@happier-dev/plugin-sdk/interactions';

import type { PermissionResult } from '../sdk/types.js';
import { isAskUserQuestionToolName } from './askUserQuestion.js';
import { resolveClaudePermissionResult, type ClaudePermissionEngine, type ClaudePermissionDecision } from './createClaudePermissionEngine.js';
import { buildClaudePermissionChoices, isClaudeExternalMcpTool } from './permissionChoices.js';

type QuestionRecord = Readonly<{
  id: string;
  prompt: string;
  multiple: boolean;
  choices: readonly [
    Readonly<{ id: string; label: string; description?: string }>,
    ...Readonly<{ id: string; label: string; description?: string }>[],
  ];
}>;

type HostQuestion = InteractionTransientAuthorQuestionV1;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toQuestionId(value: string, index: number): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || `question-${index + 1}`;
}

function readQuestions(input: unknown): QuestionRecord[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0) return null;
  const questions: QuestionRecord[] = [];
  const ids = new Set<string>();
  for (const [index, value] of input.questions.entries()) {
    if (!isRecord(value)) return null;
    const prompt = readString(value.question);
    const header = readString(value.header);
    if (!prompt || !Array.isArray(value.options) || value.options.length === 0) return null;
    let id = toQuestionId(header ?? prompt, index);
    if (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    const choices: QuestionRecord['choices'][number][] = [];
    for (const [choiceIndex, option] of value.options.entries()) {
      if (!isRecord(option)) return null;
      const label = readString(option.label);
      if (!label) return null;
      choices.push({
        id: readString(option.value) ?? `choice-${choiceIndex + 1}`,
        label,
        ...(readString(option.description) ? { description: readString(option.description)! } : {}),
      });
    }
    const firstChoice = choices[0];
    if (!firstChoice) return null;
    questions.push({
      id,
      prompt,
      multiple: value.multiSelect === true,
      choices: [firstChoice, ...choices.slice(1)],
    });
  }
  return questions;
}

function selectedLabels(
  question: QuestionRecord,
  answer: InteractionTransientQuestionAnswerV1 | undefined,
): string | null {
  if (!answer) return null;
  const choiceById = new Map(question.choices.map((choice) => [choice.id, choice.label]));
  if (answer.kind === 'singleChoice') {
    if (answer.answer.kind === 'choice') return choiceById.get(answer.answer.choiceId) ?? null;
    return readString(answer.answer.value);
  }
  if (answer.kind === 'multipleChoice') {
    const labels = answer.answers.flatMap((item) => {
      if (item.kind === 'choice') {
        const label = choiceById.get(item.choiceId);
        return label ? [label] : [];
      }
      const custom = readString(item.value);
      return custom ? [custom] : [];
    });
    return labels.length > 0 ? labels.join(', ') : null;
  }
  return null;
}

async function answerClaudeQuestions(
  context: AgentRuntimeContext,
  input: unknown,
  signal?: AbortSignal,
): Promise<PermissionResult> {
  const questions = readQuestions(input);
  if (!questions) {
    return { behavior: 'deny', message: 'Claude supplied invalid questions', interrupt: true };
  }
  const toHostQuestion = (question: QuestionRecord): HostQuestion => ({
    id: question.id,
    prompt: question.prompt,
    type: question.multiple ? 'multipleChoice' : 'singleChoice',
    required: true,
    choices: question.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      ...(choice.description ? { description: choice.description } : {}),
    })) as [QuestionRecord['choices'][number], ...QuestionRecord['choices'][number][]],
    allowCustom: true,
  });
  const [firstQuestion, ...remainingQuestions] = questions;
  if (!firstQuestion) {
    return { behavior: 'deny', message: 'Claude supplied invalid questions', interrupt: true };
  }
  const result = await context.services.interactions.askQuestions({
    kind: 'questions',
    title: 'Claude question',
    questions: [
      toHostQuestion(firstQuestion),
      ...remainingQuestions.map(toHostQuestion),
    ],
  }, signal ? { signal } : undefined);
  if (result.status !== 'answered') {
    return { behavior: 'deny', message: 'Permission denied', interrupt: true };
  }
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const answer = result.answers[question.id];
    const label = selectedLabels(question, answer);
    if (!label) return { behavior: 'deny', message: 'Permission denied', interrupt: true };
    answers[question.prompt] = label;
  }
  return {
    behavior: 'allow',
    updatedInput: {
      ...(isRecord(input) ? input : {}),
      answers,
    },
  };
}

export function allowsClaudeNativeSessionPersistence(toolName: string): boolean {
  // Explicit next-mode operations last for the Session; ordinary native tool grants remain once-only.
  return toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode'
    || isClaudeExternalMcpTool(toolName);
}

export async function requestClaudeNativePermissionDecision(
  context: AgentRuntimeContext,
  toolName: string,
  input: unknown,
  options: Parameters<ClaudePermissionEngine['canCallTool']>[2] = {},
): Promise<ClaudePermissionDecision> {
  const toolInput = AgentRuntimeJsonValueSchema.safeParse(isRecord(input) ? input : {});
  if (!toolInput.success) return { decision: 'denied', rationale: 'Claude supplied invalid tool input' };
  const toolCallId = options.toolUseId ?? options.requestId;
  const requirementId = options.requestId ?? toolCallId ?? randomUUID();
  let nativeChoices = buildClaudePermissionChoices({
    requestId: requirementId, toolName, toolInput: input,
    allowSessionPersistence: allowsClaudeNativeSessionPersistence(toolName),
  });
  const result = await context.services.interactions.requestApproval({
    kind: 'approval', title: 'Claude permission', nativeChoices,
    subject: { kind: 'tool', name: toolName, input: toolInput.data,
      ...(toolCallId ? { toolCallId } : {}),
    },
    // Session grants stay with the host; next-mode operations carry explicit setMode updates.
    ...(allowsClaudeNativeSessionPersistence(toolName) ? { allowSessionPersistence: true } : {}),
  }, { ...(options.signal ? { signal: options.signal } : {}),
    buildNativeChoices: ({ mcpTool }) => {
      nativeChoices = buildClaudePermissionChoices({ requestId: requirementId, toolName, toolInput: input,
        allowSessionPersistence: allowsClaudeNativeSessionPersistence(toolName), mcpTool });
      return nativeChoices;
    },
  });
  const selected = result.nativeChoice
    ? nativeChoices?.choices.find((choice) => choice.id === result.nativeChoice?.choiceId) : undefined;
  return selected
    ? { ...selected.response, decision: selected.decision, nativeChoice: result.nativeChoice }
    : { decision: result.status === 'approved' ? 'approved' : result.status === 'userCancelled' ? 'abort' : 'denied',
        ...(result.nativeChoice ? { nativeChoice: result.nativeChoice } : {}) };
}

export function createClaudeNativePermissionEngine(context: AgentRuntimeContext): ClaudePermissionEngine {
  return Object.freeze({
    async canCallTool(toolName, input, options = {}) {
      if (isAskUserQuestionToolName(toolName)) return await answerClaudeQuestions(context, input, options.signal);
      return resolveClaudePermissionResult(toolName, input,
        await requestClaudeNativePermissionDecision(context, toolName, input, options));
    },
  });
}
