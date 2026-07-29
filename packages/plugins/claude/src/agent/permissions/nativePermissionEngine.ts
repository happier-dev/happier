import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agent-runtime';

import type { PermissionResult } from '../sdk/types.js';
import { isAskUserQuestionToolName } from './askUserQuestion.js';
import type { ClaudePermissionEngine } from './createClaudePermissionEngine.js';

type QuestionRecord = Readonly<{
  id: string;
  prompt: string;
  multiple: boolean;
  choices: readonly [
    Readonly<{ id: string; label: string; description?: string }>,
    ...Readonly<{ id: string; label: string; description?: string }>[],
  ];
}>;

type HostQuestion = Parameters<AgentRuntimeContext['ui']['askQuestions']>[0][number];

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
  answer: Readonly<Record<string, unknown>> | undefined,
): string | null {
  if (!answer) return null;
  const choiceById = new Map(question.choices.map((choice) => [choice.id, choice.label]));
  if (answer.type === 'single' && isRecord(answer.answer)) {
    if (answer.answer.type === 'choice') return choiceById.get(String(answer.answer.choiceId)) ?? null;
    if (answer.answer.type === 'custom') return readString(answer.answer.value);
  }
  if (answer.type === 'multiple' && Array.isArray(answer.answers)) {
    const labels = answer.answers.flatMap((item) => {
      if (!isRecord(item)) return [];
      if (item.type === 'choice') {
        const label = choiceById.get(String(item.choiceId));
        return label ? [label] : [];
      }
      if (item.type === 'custom') {
        const custom = readString(item.value);
        return custom ? [custom] : [];
      }
      return [];
    });
    return labels.length > 0 ? labels.join(', ') : null;
  }
  return null;
}

async function answerClaudeQuestions(
  context: AgentRuntimeContext,
  input: unknown,
): Promise<PermissionResult> {
  const questions = readQuestions(input);
  if (!questions) {
    return { behavior: 'deny', message: 'Claude supplied invalid questions', interrupt: true };
  }
  const toHostQuestion = (question: QuestionRecord): HostQuestion => ({
    id: question.id,
    prompt: question.prompt,
    type: question.multiple ? 'multiple' : 'single',
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
  const result = await context.ui.askQuestions([
    toHostQuestion(firstQuestion),
    ...remainingQuestions.map(toHostQuestion),
  ], {
    title: 'Claude question',
  });
  if (result.status !== 'answered') {
    return { behavior: 'deny', message: 'Permission denied', interrupt: true };
  }
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const answer = result.answers[question.id];
    const label = selectedLabels(question, isRecord(answer) ? answer : undefined);
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

export function createClaudeNativePermissionEngine(
  context: AgentRuntimeContext,
): ClaudePermissionEngine {
  return Object.freeze({
    async canCallTool(toolName, input) {
      if (isAskUserQuestionToolName(toolName)) {
        return await answerClaudeQuestions(context, input);
      }
      const approved = await context.ui.confirm(`Allow Claude to use ${toolName}?`);
      return approved
        ? {
            behavior: 'allow' as const,
            updatedInput: isRecord(input) ? { ...input } : {},
          }
        : {
            behavior: 'deny' as const,
            message: 'Permission denied',
            interrupt: true,
          };
    },
  });
}
