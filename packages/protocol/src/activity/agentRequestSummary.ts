import { extractShellCommand, stripShellCommandPreludeForDisplay } from './shellCommand.js';
import { isShellToolNameAlias } from '../tools/v2/aliases.js';
import { resolveToolMutationClassification } from '../tools/toolMutationClassification.js';
import { StructuredQuestionSelectionConstraintsV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import {
  SESSION_PERMISSION_REMOTE_SUMMARY_MAX_CHOICES_PER_QUESTION,
  SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS,
} from '../sessions/permissions/v1.js';

export type AgentRequestKind = 'permission' | 'user_action';
const LEGACY_USER_ACTION_TOOLS = new Set<string>([
  'AskUserQuestion',
  'ask_user_question',
  'ExitPlanMode',
  'exit_plan_mode',
  'AcpHistoryImport',
]);

function normalizeAgentRequestKind(rawKind: unknown): AgentRequestKind | null {
  if (rawKind === 'permission') return 'permission';
  if (rawKind === 'user_action') return 'user_action';
  return null;
}

export function resolveAgentRequestKind(params: Readonly<{ toolName: string; requestKind?: unknown }>): AgentRequestKind {
  const normalized = normalizeAgentRequestKind(params.requestKind);
  if (normalized) return normalized;

  // Back-compat / defensive fallback: older agents may not publish requestKind, so we infer using
  // the existing "custom UI tool" list (these should never render a generic permission prompt).
  if (LEGACY_USER_ACTION_TOOLS.has(params.toolName)) {
    return 'user_action';
  }

  return 'permission';
}

export type AgentPermissionRisk = 'low' | 'high';
export type AgentRequestQuestionSelection = 'text' | 'single' | 'multiple';

export type AgentRequestQuestionChoiceSummary = Readonly<{
  /** User-visible label rendered by a mediator. */
  label: string;
  /** Canonical value returned to the live requester when that label is selected. */
  value: string;
  /** Optional author-provided context for the user-visible choice. */
  description?: string | null;
}>;

/**
 * Provider-neutral AskUserQuestion semantics. This is intentionally derived
 * at the existing request-summary owner rather than by each notification or
 * mediator surface parsing a provider payload for itself.
 */
export type AgentRequestQuestionSummary = Readonly<{
  /** Live requester key; never supplied by a remote mediator. */
  answerKey: string;
  /** Optional short author-provided heading for the question. */
  header?: string | null;
  question: string;
  selection: AgentRequestQuestionSelection;
  required: boolean;
  allowCustom: boolean;
  minSelections?: number;
  maxSelections?: number;
  allowNote?: boolean;
  choices: readonly AgentRequestQuestionChoiceSummary[];
  freeformDescription?: string;
  freeformPlaceholder?: string;
  freeformMultiline?: boolean;
  freeformInitialValue?: string;
  freeformAllowEmpty?: boolean;
}>;

export type AgentRequestSemanticSummary = Readonly<{
  kind: AgentRequestKind;
  rawToolName: string;
  /** Normalized tool name: classification only, never shown. */
  normalizedToolLabel: string;
  /**
   * The name every surface shows for the tool: the host's resolved label (an Action's title,
   * a readable MCP name) when it passed one, else the normalized name.
   */
  toolLabel: string;
  permissionTitle: string | null;
  permissionAction: 'run_command' | 'change_files' | 'access_file' | 'use_tool';
  shellCommand: string | null;
  filePath: string | null;
  firstQuestionText: string | null;
  questionCount: number;
  questions: readonly AgentRequestQuestionSummary[];
}>;

/** How a host phrases a permission request summary in its own language. */
export type PermissionRequestSummaryLabels = Readonly<{
  required: (tool: string) => string;
  requiredWithoutDetails: (tool: string) => string;
  run: (command: string) => string;
  read: (path: string) => string;
  write: (path: string) => string;
  edit: (path: string) => string;
}>;

const defaultPermissionSummaryLabels: PermissionRequestSummaryLabels = {
  required: tool => `Permission required: ${tool}`,
  requiredWithoutDetails: tool => `Permission required: ${tool} (details unavailable)`,
  run: command => `Run: ${command}`,
  read: path => `Read: ${path}`,
  write: path => `Write: ${path}`,
  edit: path => `Edit: ${path}`,
};

type FormatPermissionRequestSummaryParams = Readonly<{
  toolName: string;
  toolInput: unknown;
  /** The host's display name for the tool (see `AgentRequestSemanticSummary.toolLabel`). */
  toolLabel?: string | null;
  labels?: Partial<PermissionRequestSummaryLabels>;
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
    firstString(obj.filename) ??
    firstString(obj.fileName) ??
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
      choices.push(Object.freeze({
        label,
        value,
        description: firstString(optionRecord?.description),
      }));
    }
    const declaredSelection = firstString(record?.selection)?.toLowerCase();
    const selection: AgentRequestQuestionSelection = declaredSelection === 'text'
      ? 'text'
      : declaredSelection === 'multiple'
        || record?.multiSelect === true
        || record?.multiple === true
        ? 'multiple'
        : 'single';
    const freeform = asRecord(record?.freeform);
    const constraints = StructuredQuestionSelectionConstraintsV1Schema.safeParse({
      ...(record?.minSelections === undefined ? {} : { minSelections: record.minSelections }),
      ...(record?.maxSelections === undefined ? {} : { maxSelections: record.maxSelections }),
    });
    if (!constraints.success) continue;
    if (selection !== 'multiple' && (constraints.data.minSelections !== undefined || constraints.data.maxSelections !== undefined)) continue;
    const hasExplicitFreeform = freeform !== null || record?.freeform === true || record?.allowCustom === true;
    summaries.push(Object.freeze({
      answerKey: firstString(record?.id) ?? text,
      header: firstString(record?.header),
      question: text,
      selection,
      required: record?.required !== false,
      allowCustom: selection === 'text' || choices.length === 0 || hasExplicitFreeform,
      choices: Object.freeze(choices),
      ...constraints.data,
      ...(record?.allowNote === true ? { allowNote: true } : {}),
      ...(firstString(freeform?.description) ? { freeformDescription: firstString(freeform?.description)! } : {}),
      ...(firstString(freeform?.placeholder) ? { freeformPlaceholder: firstString(freeform?.placeholder)! } : {}),
      ...(typeof freeform?.multiline === 'boolean' ? { freeformMultiline: freeform.multiline } : {}),
      ...(typeof freeform?.initialValue === 'string' ? { freeformInitialValue: freeform.initialValue } : {}),
      ...(typeof freeform?.allowEmpty === 'boolean' ? { freeformAllowEmpty: freeform.allowEmpty } : {}),
    }));
  }
  return Object.freeze(summaries);
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
  /** The host's display name for the tool; this owner has no Action catalog or translations. */
  toolLabel?: string | null;
}>): AgentRequestSemanticSummary {
  const obj = asRecord(params.toolInput);
  const permission = asRecord(obj?.permission);
  const questions = extractQuestionSummaries(params.toolName, params.toolInput);
  const shellCommand = extractShellCommand(params.toolInput);
  const filePath = extractFilePathLike(params.toolInput);
  const mutation = resolveToolMutationClassification(params.toolName);
  const permissionAction = mutation === 'opaque_executor' || isShellToolNameAlias(params.toolName.trim()) || shellCommand ? 'run_command'
    : mutation === 'patch' || mutation === 'single_path' || mutation === 'path_pair' ? 'change_files'
      : filePath ? 'access_file' : 'use_tool';

  const normalizedToolLabel = normalizeToolLabel(params.toolName);
  return {
    kind: params.kind,
    rawToolName: params.toolName,
    normalizedToolLabel,
    toolLabel: params.toolLabel?.trim() || normalizedToolLabel,
    permissionTitle: firstString(permission?.title) ?? firstString(obj?.title) ?? null,
    permissionAction,
    shellCommand,
    filePath,
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

/**
 * What a permission request asks, as a verb and its subject ("Run: …", "Edit: <path>"), or the
 * agent's own permission title. Null when only the generic "Permission required" line applies, so a
 * host keeps its own name for the tool. The one decision behind the summary line and a card title.
 */
export function formatPermissionRequestHeadline(params: FormatPermissionRequestSummaryParams): string | null {
  const summary = buildAgentRequestSemanticSummary({
    kind: 'permission',
    toolName: params.toolName,
    toolInput: params.toolInput,
    toolLabel: params.toolLabel,
  });
  const labels = { ...defaultPermissionSummaryLabels, ...params.labels };
  const lower = summary.normalizedToolLabel.toLowerCase();

  if (summary.permissionTitle) {
    return summary.permissionTitle;
  }

  if (summary.shellCommand && (lower === 'bash' || lower === 'execute' || lower === 'shell')) {
    return labels.run(summary.shellCommand);
  }

  if (summary.filePath && (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'multiedit')) {
    const verb = lower === 'read' ? labels.read : lower === 'write' ? labels.write : labels.edit;
    return verb(summary.filePath);
  }

  return null;
}

export function formatPermissionRequestSummary(params: FormatPermissionRequestSummaryParams): string {
  const headline = formatPermissionRequestHeadline(params);
  if (headline) return headline;

  const labels = { ...defaultPermissionSummaryLabels, ...params.labels };
  const toolLabel = params.toolLabel?.trim() || normalizeToolLabel(params.toolName);
  const obj = asRecord(params.toolInput);
  if (!obj || Object.keys(obj).length === 0) {
    return labels.requiredWithoutDetails(toolLabel);
  }

  return labels.required(toolLabel);
}

export function extractFirstUserActionQuestion(toolName: string, toolInput: unknown): string | null {
  return buildAgentRequestSemanticSummary({
    kind: 'user_action',
    toolName,
    toolInput,
  }).firstQuestionText;
}

export type RequestNotificationLabels = Readonly<{
  command: string;
  file: string;
  selectOne: string;
  selectMultiple: string;
  customAnswer: string;
  localMessages: string;
  remoteMessages: string;
  answerAll: (count: number) => string;
}>;

const defaultLabels: RequestNotificationLabels = {
  command: 'Command', file: 'File', selectOne: 'Select one',
  selectMultiple: 'Select multiple', customAnswer: 'Custom answer allowed',
  localMessages: 'Local messages', remoteMessages: 'Remote messages',
  answerAll: count => `Answer all ${count} in Happier`,
};

export function requiresFullFormForRemoteUserAction(questions: readonly AgentRequestQuestionSummary[]): boolean {
  return questions.length > SESSION_PERMISSION_REMOTE_SUMMARY_MAX_QUESTIONS
    || questions.some((question) => question.choices.length > SESSION_PERMISSION_REMOTE_SUMMARY_MAX_CHOICES_PER_QUESTION);
}

export function summarizeToolInputForNotification(toolName: string, toolInput: unknown, labels?: Partial<RequestNotificationLabels>): string | null {
  const display = { ...defaultLabels, ...labels };
  const summary = buildAgentRequestSemanticSummary({
    kind: isAskUserQuestionToolName(toolName) ? 'user_action' : 'permission',
    toolName,
    toolInput,
  });
  if (summary.questions.length) {
    if (requiresFullFormForRemoteUserAction(summary.questions)) {
      return display.answerAll(summary.questionCount);
    }
    return summary.questions.map((question) => [
      question.header && question.header !== question.question ? question.header : null,
      question.question,
      question.choices.length ? question.selection === 'multiple' ? display.selectMultiple : display.selectOne : null,
      ...question.choices.map((choice) => `• ${choice.label}${choice.description ? ` — ${choice.description}` : ''}`),
      question.allowCustom ? display.customAnswer : null,
      question.freeformDescription,
      question.freeformPlaceholder,
    ].filter(Boolean).join('\n')).join('\n\n');
  }
  const record = asRecord(toolInput);
  const tool = toolName.trim().toLowerCase();
  const actionDetails: Array<string | null> = [];
  if (tool === 'exitplanmode' || tool === 'exit_plan_mode') {
    actionDetails.push(firstString(record?.name), firstString(record?.overview), firstString(record?.plan));
  } else if (tool === 'acphistoryimport') {
    actionDetails.push(firstString(record?.note));
    if (typeof record?.localCount === 'number') actionDetails.push(`${display.localMessages}: ${record.localCount}`);
    if (typeof record?.remoteCount === 'number') actionDetails.push(`${display.remoteMessages}: ${record.remoteCount}`);
  } else if (tool === 'webfetch' || tool === 'web_fetch') {
    actionDetails.push(firstString(record?.url));
  } else if (tool === 'websearch' || tool === 'web_search') {
    actionDetails.push(firstString(record?.query));
  }
  const permission = asRecord(record?.permission);
  const command = summary.shellCommand ?? extractShellCommand({ command: record?.script });
  const details = [
    ...actionDetails,
    summary.permissionTitle,
    command ? `${display.command}: ${command}` : null,
    summary.filePath ? `${display.file}: ${summary.filePath}` : null,
    firstString(permission?.description) ?? firstString(record?.description),
    firstString(permission?.justification) ?? firstString(record?.justification),
    firstString(permission?.reason) ?? firstString(record?.reason),
    firstString(permission?.rationale) ?? firstString(record?.rationale),
  ].filter((value): value is string => value !== null);
  return [...new Set(details)].join('\n') || null;
}
