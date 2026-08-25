import { extractShellCommand, stripShellCommandPreludeForDisplay } from './shellCommand.js';

export type AgentRequestKind = 'permission' | 'user_action';
export type AgentPermissionRisk = 'low' | 'high';
export type AgentRequestQuestionSelection = 'text' | 'single' | 'multiple';

export type AgentRequestQuestionChoiceSummary = Readonly<{
  /** User-visible label rendered by a mediator. */
  label: string;
  /** Canonical value returned to the live requester when that label is selected. */
  value: string;
}>;

/**
 * Provider-neutral AskUserQuestion semantics. This is intentionally derived
 * at the existing request-summary owner rather than by each notification or
 * mediator surface parsing a provider payload for itself.
 */
export type AgentRequestQuestionSummary = Readonly<{
  /** Live requester key; never supplied by a remote mediator. */
  answerKey: string;
  question: string;
  selection: AgentRequestQuestionSelection;
  required: boolean;
  allowCustom: boolean;
  choices: readonly AgentRequestQuestionChoiceSummary[];
}>;

export type AgentRequestSemanticSummary = Readonly<{
  kind: AgentRequestKind;
  rawToolName: string;
  normalizedToolLabel: string;
  permissionTitle: string | null;
  shellCommand: string | null;
  filePath: string | null;
  firstQuestionText: string | null;
  questionCount: number;
  questions: readonly AgentRequestQuestionSummary[];
}>;

type FormatPermissionRequestSummaryParams = Readonly<{
  toolName: string;
  toolInput: unknown;
}>;

type ClassifyPermissionRequestRiskParams = Readonly<{
  toolName: string;
  toolInput: unknown;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstStringFromUnknown(value: unknown): string | null {
  const direct = firstString(value);
  if (direct) return direct;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const fromItem = firstString(item);
    if (fromItem) return fromItem;
  }
  return null;
}

function normalizeToolLabel(toolName: string): string {
  const raw = toolName.trim();
  if (!raw) return 'tool operation';
  if (isAskUserQuestionToolName(raw)) return 'AskUserQuestion';
  const lower = raw.toLowerCase();
  if (lower === 'unknown' || lower === 'unknown tool' || lower === 'other') {
    return 'tool operation';
  }
  return raw;
}

export function isAskUserQuestionToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === 'askuserquestion' || normalized === 'ask_user_question';
}

function extractFirstPathFromArray(
  value: unknown,
  keys: readonly string[] = ['path', 'filePath'],
): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = asRecord(value[0]);
  if (!first) return null;
  for (const key of keys) {
    const next = firstString(first[key]);
    if (next) return next;
  }
  return null;
}

function extractFilePathLike(input: unknown): string | null {
  const obj = asRecord(input);
  if (!obj) return null;

  const locationPath = extractFirstPathFromArray(obj.locations);
  if (locationPath) return locationPath;

  const toolCall = asRecord(obj.toolCall);
  const toolCallLocationPath = extractFirstPathFromArray(toolCall?.locations);
  if (toolCallLocationPath) return toolCallLocationPath;

  const toolCallContentPath = extractFirstPathFromArray((toolCall as { content?: unknown } | null)?.content, ['path']);
  if (toolCallContentPath) return toolCallContentPath;

  const inputPath = extractFirstPathFromArray((obj as { input?: unknown }).input, ['path']);
  if (inputPath) return inputPath;

  const itemPath = extractFirstPathFromArray(obj.items);
  if (itemPath) return itemPath;

  return (
    firstString(obj.filePath) ??
    firstString(obj.file_path) ??
    firstString(obj.path) ??
    firstString(obj.filepath) ??
    firstString(obj.file) ??
    null
  );
}

function extractQuestionSummaries(
  toolName: string,
  toolInput: unknown,
): readonly AgentRequestQuestionSummary[] {
  if (!isAskUserQuestionToolName(toolName)) return [];
  const obj = asRecord(toolInput);
  const questions = Array.isArray(obj?.questions) ? obj.questions : [];
  const summaries: AgentRequestQuestionSummary[] = [];
  for (const question of questions) {
    const record = asRecord(question);
    const text = firstString(record?.question) ?? firstString(record?.header);
    if (!text) continue;
    const optionValues = Array.isArray(record?.options)
      ? record.options
      : Array.isArray(record?.choices)
        ? record.choices
        : [];
    const choices: AgentRequestQuestionChoiceSummary[] = [];
    for (const option of optionValues) {
      const optionRecord = asRecord(option);
      const label = firstString(optionRecord?.label) ?? firstString(option);
      if (!label) continue;
      const value = firstString(optionRecord?.id)
        ?? firstString(optionRecord?.choice)
        ?? firstString(optionRecord?.value)
        ?? label;
      choices.push(Object.freeze({ label, value }));
    }
    const declaredSelection = firstString(record?.selection)?.toLowerCase();
    const selection: AgentRequestQuestionSelection = declaredSelection === 'text'
      ? 'text'
      : declaredSelection === 'multiple'
        || record?.multiSelect === true
        || record?.multiple === true
        ? 'multiple'
        : 'single';
    const hasExplicitFreeform = asRecord(record?.freeform) !== null || record?.allowCustom === true;
    summaries.push(Object.freeze({
      answerKey: firstString(record?.id) ?? text,
      question: text,
      selection,
      required: record?.required !== false,
      allowCustom: selection === 'text' || choices.length === 0 || hasExplicitFreeform,
      choices: Object.freeze(choices),
    }));
  }
  return Object.freeze(summaries);
}

function shortPath(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function commandName(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  return value.split(/\s+/).filter(Boolean)[0] ?? '';
}

function normalizedToolName(toolName: string): string {
  return normalizeToolLabel(toolName).toLowerCase();
}

function isReadOnlyShellCommand(command: string): boolean {
  const normalized = stripShellCommandPreludeForDisplay(command).trim();
  if (!normalized) return false;
  if (/[;&|`$<>]/.test(normalized)) return false;
  if (/\b(rm|mv|cp|chmod|chown|mkdir|rmdir|touch|truncate|tee|sed|perl|python|python3|node|npm|pnpm|yarn|bun|npx|find|git\s+(?:add|commit|push|pull|fetch|merge|rebase|checkout|switch|reset|restore|clean|apply|am|branch\s+-[dD]))\b/i.test(normalized)) {
    return false;
  }

  return /^(?:pwd|ls(?:\s|$)|cat\s|head\s|tail\s|rg\s|grep\s|git\s+(?:status|diff|log|show)(?:\s|$)|git\s+branch(?:\s+--show-current|\s+--contains)?\s*$)/i.test(normalized);
}

export function buildAgentRequestSemanticSummary(params: Readonly<{
  kind: AgentRequestKind;
  toolName: string;
  toolInput: unknown;
}>): AgentRequestSemanticSummary {
  const obj = asRecord(params.toolInput);
  const permission = asRecord(obj?.permission);
  const questions = extractQuestionSummaries(params.toolName, params.toolInput);

  return {
    kind: params.kind,
    rawToolName: params.toolName,
    normalizedToolLabel: normalizeToolLabel(params.toolName),
    permissionTitle: firstString(permission?.title) ?? firstString(obj?.title) ?? null,
    shellCommand: extractShellCommand(params.toolInput),
    filePath: extractFilePathLike(params.toolInput),
    firstQuestionText: questions[0]?.question ?? null,
    questionCount: questions.length,
    questions,
  };
}

export function classifyPermissionRequestRisk(
  params: ClassifyPermissionRequestRiskParams,
): AgentPermissionRisk {
  const lower = normalizedToolName(params.toolName);

  if (lower === 'bash' || lower === 'execute' || lower === 'shell') {
    const command = extractShellCommand(params.toolInput);
    return command && isReadOnlyShellCommand(command) ? 'low' : 'high';
  }

  if (
    lower === 'read'
    || lower === 'grep'
    || lower === 'glob'
    || lower === 'ls'
    || lower === 'webfetch'
    || lower === 'websearch'
    || lower === 'bashoutput'
  ) {
    return 'low';
  }

  return 'high';
}

export function formatPermissionRequestSummary(params: FormatPermissionRequestSummaryParams): string {
  const summary = buildAgentRequestSemanticSummary({
    kind: 'permission',
    toolName: params.toolName,
    toolInput: params.toolInput,
  });
  const lower = summary.normalizedToolLabel.toLowerCase();

  if (summary.permissionTitle) {
    return summary.permissionTitle;
  }

  if (summary.shellCommand && (lower === 'bash' || lower === 'execute' || lower === 'shell')) {
    return `Run: ${summary.shellCommand}`;
  }

  if (summary.filePath && (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'multiedit')) {
    const verb = lower === 'read' ? 'Read' : lower === 'write' ? 'Write' : 'Edit';
    return `${verb}: ${summary.filePath}`;
  }

  const obj = asRecord(params.toolInput);
  if (!obj || Object.keys(obj).length === 0) {
    return `Permission required: ${summary.normalizedToolLabel} (details unavailable)`;
  }

  return `Permission required: ${summary.normalizedToolLabel}`;
}

export function extractFirstUserActionQuestion(toolName: string, toolInput: unknown): string | null {
  return buildAgentRequestSemanticSummary({
    kind: 'user_action',
    toolName,
    toolInput,
  }).firstQuestionText;
}

export function summarizeToolInputForNotification(toolName: string, toolInput: unknown): string | null {
  const summary = buildAgentRequestSemanticSummary({
    kind: isAskUserQuestionToolName(toolName) ? 'user_action' : 'permission',
    toolName,
    toolInput,
  });

  if (summary.filePath) return `File: ${shortPath(summary.filePath)}`;

  const directCommand =
    summary.shellCommand ??
    firstStringFromUnknown(asRecord(toolInput)?.command) ??
    firstStringFromUnknown(asRecord(toolInput)?.cmd) ??
    firstStringFromUnknown(asRecord(toolInput)?.script);
  if (directCommand) {
    const name = commandName(directCommand);
    return name ? `Command: ${name}` : null;
  }

  if (summary.questionCount === 1) return '1 question';
  if (summary.questionCount > 1) return `${summary.questionCount} questions`;

  const normalized = summary.normalizedToolLabel;
  if (normalized === 'Read' || normalized === 'Write' || normalized === 'Edit' || normalized === 'Bash') {
    return null;
  }
  return null;
}
