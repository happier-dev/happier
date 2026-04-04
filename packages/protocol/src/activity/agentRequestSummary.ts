import { extractShellCommand } from './shellCommand.js';

export type AgentRequestKind = 'permission' | 'user_action';

export type AgentRequestSemanticSummary = Readonly<{
  kind: AgentRequestKind;
  rawToolName: string;
  normalizedToolLabel: string;
  permissionTitle: string | null;
  shellCommand: string | null;
  filePath: string | null;
  firstQuestionText: string | null;
  questionCount: number;
}>;

type FormatPermissionRequestSummaryParams = Readonly<{
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
  const lower = raw.toLowerCase();
  if (lower === 'unknown' || lower === 'unknown tool' || lower === 'other') {
    return 'tool operation';
  }
  return raw;
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

function extractQuestionTexts(toolName: string, toolInput: unknown): string[] {
  if (toolName !== 'AskUserQuestion') return [];
  const obj = asRecord(toolInput);
  const questions = Array.isArray(obj?.questions) ? obj.questions : [];
  const texts: string[] = [];
  for (const question of questions) {
    const record = asRecord(question);
    const next = firstString(record?.question);
    if (next) texts.push(next);
  }
  return texts;
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

export function buildAgentRequestSemanticSummary(params: Readonly<{
  kind: AgentRequestKind;
  toolName: string;
  toolInput: unknown;
}>): AgentRequestSemanticSummary {
  const obj = asRecord(params.toolInput);
  const permission = asRecord(obj?.permission);
  const questions = extractQuestionTexts(params.toolName, params.toolInput);

  return {
    kind: params.kind,
    rawToolName: params.toolName,
    normalizedToolLabel: normalizeToolLabel(params.toolName),
    permissionTitle: firstString(permission?.title) ?? firstString(obj?.title) ?? null,
    shellCommand: extractShellCommand(params.toolInput),
    filePath: extractFilePathLike(params.toolInput),
    firstQuestionText: questions[0] ?? null,
    questionCount: questions.length,
  };
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
    kind: toolName === 'AskUserQuestion' ? 'user_action' : 'permission',
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
