import {
  normalizeClaudeActivityStatusSignal,
  type ClaudeActivityStatusSignal,
} from '../activityStatus.js';
import {
  normalizeResultPreview,
  normalizeSummary,
  readModel,
  readTokensUsed,
  readToolCalls,
  readDurationSecondsFromMs,
  readUsageMetrics,
  type ClaudeWorkflowUsageMetrics,
} from './metrics.js';

/**
 * Claude-native event parsing for the workflow normalizer (CWF2).
 *
 * Turns a raw transcript row (raw JSONL value) into one of a small set of provider-neutral
 * "facts" the tracker applies. This is the ONLY module that reads Claude-native event shapes
 * (`Workflow` tool_use, `task_started`/`task_progress`/`task_updated`/`task_notification`,
 * `workflow_progress[]`, `Task` subagents). The tracker/projection stay shape-agnostic.
 */

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSourceSessionId(message: Record<string, unknown>): string | undefined {
  return readString(message.session_id) ?? readString(message.sessionId) ?? undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const parsed = readNumber(value);
  return parsed !== undefined && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

/** A `Workflow {script}` tool-use that starts an explicit workflow run. */
export type WorkflowStartFact = Readonly<{
  kind: 'workflow-start';
  workflowToolUseId: string;
  title: string;
  phases?: readonly WorkflowProgressPhaseFact[];
  journalAgentSpecs?: readonly WorkflowJournalAgentSpecFact[];
  sourceSessionId?: string;
  uuid?: string;
}>;

/** A `Workflow` async-launch tool result that exposes the sidecar transcript directory. */
export type WorkflowLaunchFact = Readonly<{
  kind: 'workflow-launch';
  workflowToolUseId: string;
  taskId?: string;
  title?: string;
  summary?: string;
  transcriptDir?: string;
  sourceSessionId?: string;
  uuid?: string;
}>;

/** A `task_started`/`task_updated`/`task_notification`/`task_progress` system event. */
export type TaskLifecycleFact = Readonly<{
  kind: 'task-lifecycle';
  /** subtype: task_started | task_progress | task_updated | task_notification */
  subtype: string;
  taskId?: string;
  /** The workflow/subagent tool-use id the task belongs to (correlation hook). */
  toolUseId?: string;
  /** `local_workflow` for Dynamic Workflows; `subagent` etc. for plain subagents. */
  taskType?: string;
  status: ClaudeActivityStatusSignal;
  title?: string;
  summary?: string;
  resultPreview?: string;
  model?: string;
  usage: ClaudeWorkflowUsageMetrics;
  sourceSessionId?: string;
  startedAt?: number;
  completedAt?: number;
  /** Phase/agent progress rows, present only on Dynamic Workflow `task_progress`. */
  workflowProgress?: readonly WorkflowProgressEntryFact[];
  uuid?: string;
}>;

/** A plain `Task` subagent tool-use (no workflow_progress) — implicit-run candidate. */
export type SubagentStartFact = Readonly<{
  kind: 'subagent-start';
  toolUseId: string;
  title: string;
  parentToolUseId?: string;
  sourceSessionId?: string;
  uuid?: string;
}>;

export type WorkflowProgressPhaseFact = Readonly<{
  kind: 'phase';
  index: number;
  title?: string;
}>;

export type WorkflowProgressAgentFact = Readonly<{
  kind: 'agent';
  id: string;
  vendorRef?: string;
  title: string;
  status: ClaudeActivityStatusSignal;
  attempt?: number;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  resultPreview?: string;
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
}>;

export type WorkflowProgressEntryFact = WorkflowProgressPhaseFact | WorkflowProgressAgentFact;

export type WorkflowJournalAgentSpecFact = Readonly<{
  label: string;
  phaseTitle?: string;
}>;

export type WorkflowJournalFact = Readonly<{
  kind: 'workflow-journal';
  workflowToolUseId: string;
  journalKey?: string;
  agentId: string;
  status: ClaudeActivityStatusSignal;
  title: string;
  phaseTitle?: string;
  resultPreview?: string;
  summary?: string;
  sourceSessionId?: string;
}>;

export type ClaudeWorkflowFact =
  | WorkflowStartFact
  | WorkflowLaunchFact
  | TaskLifecycleFact
  | SubagentStartFact
  | WorkflowJournalFact;

const TASK_LIFECYCLE_SUBTYPES = new Set([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
]);

function readWorkflowName(input: Record<string, unknown> | null): string | null {
  // `Workflow {script}` carries the workflow name in the script's `meta.name`; fall back to a
  // description if present. Avoids storing raw scripts in the snapshot.
  const description = readString(input?.description);
  if (description) return description;
  const script = readString(input?.script);
  if (script) {
    const match = script.match(/name:\s*['"]([^'"]+)['"]/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function readWorkflowPhases(input: Record<string, unknown> | null): WorkflowProgressPhaseFact[] | undefined {
  const script = readString(input?.script);
  if (!script) return undefined;

  const titles: string[] = [];
  for (const match of script.matchAll(/\{\s*title\s*:\s*['"]([^'"]+)['"]/g)) {
    const title = readString(match[1]);
    if (title && !titles.includes(title)) titles.push(title);
  }
  for (const match of script.matchAll(/\bphase\s*\(\s*['"]([^'"]+)['"]/g)) {
    const title = readString(match[1]);
    if (title && !titles.includes(title)) titles.push(title);
  }

  if (titles.length === 0) return undefined;
  return titles.map((title, index) => ({ kind: 'phase', index: index + 1, title }));
}

function readWorkflowJournalAgentSpecs(input: Record<string, unknown> | null): WorkflowJournalAgentSpecFact[] | undefined {
  const script = readString(input?.script);
  if (!script) return undefined;

  const specs: WorkflowJournalAgentSpecFact[] = [];
  let currentPhase: string | undefined;
  for (const line of script.split('\n')) {
    const phaseMatch = line.match(/\bphase\s*\(\s*['"]([^'"]+)['"]/);
    if (phaseMatch?.[1]) {
      currentPhase = readString(phaseMatch[1]) ?? currentPhase;
    }

    const labelMatch = line.match(/\blabel\s*:\s*['"]([^'"]+)['"]/);
    if (!labelMatch?.[1]) continue;
    const label = readString(labelMatch[1]);
    if (!label) continue;

    const phaseOptionMatch = line.match(/\bphase\s*:\s*['"]([^'"]+)['"]/);
    const phaseTitle = readString(phaseOptionMatch?.[1]) ?? currentPhase;
    specs.push({
      label,
      ...(phaseTitle ? { phaseTitle } : {}),
    });
  }

  return specs.length > 0 ? specs : undefined;
}

function parseWorkflowProgress(value: unknown): WorkflowProgressEntryFact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const facts: WorkflowProgressEntryFact[] = [];
  for (const entry of value) {
    const record = readRecord(entry);
    if (!record) continue;
    if (record.type === 'workflow_phase') {
      const index = readNumber(record.index);
      if (index === undefined) continue;
      const title = readString(record.title);
      facts.push({ kind: 'phase', index, ...(title ? { title } : {}) });
      continue;
    }
    if (record.type === 'workflow_agent') {
      const index = readNonNegativeInteger(record.index);
      const vendorRef = readString(record.agentId);
      const id = index !== undefined ? `workflow-agent:${index}` : vendorRef ?? readString(record.label);
      if (!id) continue;
      const title = readString(record.label) ?? id;
      const status = normalizeClaudeActivityStatusSignal(record.state);
      const attempt = readNonNegativeInteger(record.attempt);
      const phaseIndex = readNumber(record.phaseIndex);
      const phaseTitle = readString(record.phaseTitle);
      const model = readModel(record.model);
      const resultPreview = normalizeResultPreview(record.resultPreview);
      const tokensUsed = readTokensUsed(record.tokens);
      const toolCalls = readToolCalls(record.toolCalls);
      const timeUsedSeconds = readDurationSecondsFromMs(record.durationMs);
      facts.push({
        kind: 'agent',
        id,
        ...(vendorRef ? { vendorRef } : {}),
        title,
        status,
        ...(attempt !== undefined ? { attempt } : {}),
        ...(phaseIndex !== undefined ? { phaseIndex } : {}),
        ...(phaseTitle ? { phaseTitle } : {}),
        ...(model ? { model } : {}),
        ...(resultPreview ? { resultPreview } : {}),
        ...(tokensUsed !== undefined ? { tokensUsed } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
      });
    }
  }
  return facts;
}

function parseWorkflowToolUse(message: Record<string, unknown>): WorkflowStartFact | null {
  if (message.type !== 'assistant') return null;
  const nested = readRecord(message.message);
  const content = nested?.content;
  if (!Array.isArray(content)) return null;
  const sourceSessionId = readSourceSessionId(message);
  const uuid = readString(message.uuid) ?? undefined;
  for (const part of content) {
    const block = readRecord(part);
    if (block?.type !== 'tool_use' || block.name !== 'Workflow') continue;
    const id = readString(block.id);
    if (!id) continue;
    const input = readRecord(block.input);
    const title = readWorkflowName(input) ?? 'Workflow';
    const phases = readWorkflowPhases(input);
    const journalAgentSpecs = readWorkflowJournalAgentSpecs(input);
    return {
      kind: 'workflow-start',
      workflowToolUseId: id,
      title,
      ...(phases ? { phases } : {}),
      ...(journalAgentSpecs ? { journalAgentSpecs } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(uuid ? { uuid } : {}),
    };
  }
  return null;
}

function readToolResultContentText(block: Record<string, unknown>): string | null {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const record = readRecord(item);
    if (record?.type === 'text') {
      const text = readString(record.text);
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function parseWorkflowLaunchResult(message: Record<string, unknown>): WorkflowLaunchFact | null {
  if (message.type !== 'user') return null;
  const nested = readRecord(message.message);
  const content = nested?.content;
  if (!Array.isArray(content)) return null;

  const toolUseResult = readRecord(message.toolUseResult) ?? readRecord(message.tool_use_result);
  const sourceSessionId = readSourceSessionId(message);
  const uuid = readString(message.uuid) ?? undefined;

  for (const part of content) {
    const block = readRecord(part);
    if (block?.type !== 'tool_result') continue;
    const workflowToolUseId = readString(block.tool_use_id);
    if (!workflowToolUseId) continue;

    const contentText = readToolResultContentText(block);
    const taskType = readString(toolUseResult?.taskType) ?? readString(toolUseResult?.task_type);
    const status = readString(toolUseResult?.status);
    const transcriptDir =
      readString(toolUseResult?.transcriptDir)
      ?? readString(toolUseResult?.transcript_dir)
      ?? (() => {
        const match = contentText?.match(/Transcript dir:\s*([^\n]+)/);
        return readString(match?.[1]);
      })();

    const isWorkflowLaunch = taskType === 'local_workflow'
      || status === 'async_launched'
      || contentText?.includes('Workflow launched in background') === true
      || transcriptDir !== null;
    if (!isWorkflowLaunch) continue;

    const title = readString(toolUseResult?.workflowName) ?? readString(toolUseResult?.workflow_name);
    const summary = normalizeSummary(toolUseResult?.summary);
    const taskId = readString(toolUseResult?.taskId) ?? readString(toolUseResult?.task_id);
    return {
      kind: 'workflow-launch',
      workflowToolUseId,
      ...(taskId ? { taskId } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(transcriptDir ? { transcriptDir } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(uuid ? { uuid } : {}),
    };
  }
  return null;
}

function parseSubagentUse(message: Record<string, unknown>): SubagentStartFact | null {
  if (message.type !== 'assistant') return null;
  const nested = readRecord(message.message);
  const content = nested?.content;
  if (!Array.isArray(content)) return null;
  const sourceSessionId = readSourceSessionId(message);
  const parentToolUseId = readString(message.parent_tool_use_id) ?? undefined;
  const uuid = readString(message.uuid) ?? undefined;
  for (const part of content) {
    const block = readRecord(part);
    if (block?.type !== 'tool_use' || block.name !== 'Task') continue;
    const id = readString(block.id);
    if (!id) continue;
    const input = readRecord(block.input);
    const title = readString(input?.description) ?? readString(input?.subagent_type) ?? 'Subagent';
    return {
      kind: 'subagent-start',
      toolUseId: id,
      title,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(uuid ? { uuid } : {}),
    };
  }
  return null;
}

/** Collect text content from a Claude message content value (string or text block array). */
function readMessageContentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    const block = readRecord(part);
    if (block?.type === 'text') {
      const text = readString(block.text);
      if (text) texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/** Collect the text content of a `type:"user"` message. */
function readUserMessageText(message: Record<string, unknown>): string | null {
  const nested = readRecord(message.message);
  return readMessageContentText(nested?.content);
}

function readTaskNotificationEnvelopeText(message: Record<string, unknown>): string | null {
  if (message.type === 'user') return readUserMessageText(message);
  if (message.type === 'queue-operation' && message.operation === 'enqueue') {
    return readMessageContentText(message.content);
  }
  if (message.type === 'attachment') {
    const attachment = readRecord(message.attachment);
    if (attachment?.type !== 'queued_command') return null;
    return readString(attachment.prompt);
  }
  return null;
}

function readXmlTag(source: string, tag: string): string | null {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] !== undefined ? readString(match[1]) : null;
}

/**
 * Parse the `<task-notification>` user message Claude Code persists when a backgrounded Workflow/Task
 * completes. This is the ONLY terminal lifecycle signal in the persisted transcript for backgrounded
 * runs (no `task_updated` row is written), so without it an explicit Workflow run never closes and the
 * work-state badge stays stuck "Running". It routes to the run via `<tool-use-id>` like a system
 * `task_*` event, so the tracker needs no change.
 */
function parseTaskNotificationEnvelope(message: Record<string, unknown>): TaskLifecycleFact | null {
  const text = readTaskNotificationEnvelopeText(message);
  if (!text || !text.includes('<task-notification')) return null;
  const taskId = readXmlTag(text, 'task-id');
  const toolUseId = readXmlTag(text, 'tool-use-id');
  // Without a tool-use-id there is no correlation hook; do not synthesize a run.
  if (!toolUseId) return null;

  const status = normalizeClaudeActivityStatusSignal(readXmlTag(text, 'status'), 'task_notification');
  const summary = normalizeSummary(readXmlTag(text, 'summary'));
  const resultPreview = normalizeResultPreview(readXmlTag(text, 'result') ?? readXmlTag(text, 'summary'));
  const sourceSessionId = readSourceSessionId(message);
  const uuid = readString(message.uuid) ?? undefined;

  return {
    kind: 'task-lifecycle',
    subtype: 'task_notification',
    ...(taskId ? { taskId } : {}),
    toolUseId,
    status,
    ...(summary ? { summary } : {}),
    ...(resultPreview ? { resultPreview } : {}),
    usage: {},
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(uuid ? { uuid } : {}),
  };
}

function parseTaskLifecycle(message: Record<string, unknown>): TaskLifecycleFact | null {
  if (message.type !== 'system') return null;
  const subtype = readString(message.subtype);
  if (!subtype || !TASK_LIFECYCLE_SUBTYPES.has(subtype)) return null;

  // `task_updated` carries status under `patch.status`; others carry it directly.
  const patch = readRecord(message.patch);
  const rawStatus = subtype === 'task_updated' ? patch?.status : message.status;
  const status = normalizeClaudeActivityStatusSignal(rawStatus, subtype);

  const usage = readUsageMetrics(message.usage);
  const model = readModel(message.model);
  const summary = normalizeSummary(message.summary);
  // `task_notification` carries the final result/summary; `task_progress` carries progress summary.
  const resultPreview = normalizeResultPreview(message.result ?? message.summary);
  const workflowProgress = parseWorkflowProgress(message.workflow_progress);
  const startedAt = readNumber(message.start_time);
  const completedAt = readNumber(message.end_time) ?? readNumber(patch?.end_time);

  return {
    kind: 'task-lifecycle',
    subtype,
    ...(readString(message.task_id) ? { taskId: readString(message.task_id) as string } : {}),
    ...(readString(message.tool_use_id) ? { toolUseId: readString(message.tool_use_id) as string } : {}),
    ...(readString(message.task_type) ? { taskType: readString(message.task_type) as string } : {}),
    status,
    ...(readString(message.description) ? { title: readString(message.description) as string } : {}),
    ...(summary ? { summary } : {}),
    ...(resultPreview ? { resultPreview } : {}),
    ...(model ? { model } : {}),
    usage,
    ...(readSourceSessionId(message) ? { sourceSessionId: readSourceSessionId(message) as string } : {}),
    ...(startedAt !== undefined ? { startedAt: Math.trunc(startedAt) } : {}),
    ...(completedAt !== undefined ? { completedAt: Math.trunc(completedAt) } : {}),
    ...(workflowProgress ? { workflowProgress } : {}),
    ...(readString(message.uuid) ? { uuid: readString(message.uuid) as string } : {}),
  };
}

const WORKFLOW_JOURNAL_WRAPPER_TYPE = 'happier_workflow_journal';

export function createClaudeWorkflowJournalWrapper(params: Readonly<{
  workflowToolUseId: string;
  entry: unknown;
  sourceSessionId?: string | undefined;
}>): Record<string, unknown> {
  return {
    type: WORKFLOW_JOURNAL_WRAPPER_TYPE,
    workflowToolUseId: params.workflowToolUseId,
    entry: params.entry,
    ...(params.sourceSessionId ? { sourceSessionId: params.sourceSessionId } : {}),
  };
}

function stringifyJournalResult(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeResultPreview(value);
  if (value === undefined) return undefined;
  const record = readRecord(value);
  const preview = normalizeResultPreview(record?.summary ?? record?.message ?? record?.verdict ?? record?.result);
  if (preview) return preview;
  try {
    return normalizeResultPreview(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function readJournalResultTitle(result: Record<string, unknown> | null, fallback: string): string {
  return readString(result?.lane)
    ?? readString(result?.label)
    ?? readString(result?.item)
    ?? readString(result?.message)
    ?? fallback;
}

function parseWorkflowJournalFact(message: Record<string, unknown>): WorkflowJournalFact | null {
  if (message.type !== WORKFLOW_JOURNAL_WRAPPER_TYPE) return null;
  const workflowToolUseId = readString(message.workflowToolUseId);
  const entry = readRecord(message.entry);
  if (!workflowToolUseId || !entry) return null;

  const entryType = readString(entry.type);
  if (entryType !== 'started' && entryType !== 'result') return null;

  const journalKey = readString(entry.key) ?? undefined;
  const agentId = readString(entry.agentId) ?? journalKey;
  if (!agentId) return null;

  const result = entryType === 'result' ? entry.result : undefined;
  const resultRecord = readRecord(result);
  const resultPreview = stringifyJournalResult(result);
  const summary = normalizeSummary(resultRecord?.summary ?? resultRecord?.message ?? result);
  const phaseTitle = readString(resultRecord?.stage) ?? readString(resultRecord?.phase) ?? undefined;
  const title = entryType === 'result' ? readJournalResultTitle(resultRecord, agentId) : agentId;
  const sourceSessionId = readString(message.sourceSessionId) ?? undefined;

  return {
    kind: 'workflow-journal',
    workflowToolUseId,
    ...(journalKey ? { journalKey } : {}),
    agentId,
    status: entryType === 'result' ? 'complete' : 'active',
    title,
    ...(phaseTitle ? { phaseTitle } : {}),
    ...(resultPreview ? { resultPreview } : {}),
    ...(summary ? { summary } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
  };
}

/**
 * Parse one raw transcript value into a workflow fact, or `null` if it carries no workflow-relevant
 * signal. The tracker decides routing/promotion; this only extracts shapes.
 */
export function parseClaudeWorkflowFact(value: unknown): ClaudeWorkflowFact | null {
  const message = readRecord(value);
  if (!message) return null;
  return (
    parseTaskNotificationEnvelope(message)
    ?? parseWorkflowJournalFact(message)
    ?? parseWorkflowLaunchResult(message)
    ?? parseWorkflowToolUse(message)
    ?? parseTaskLifecycle(message)
    ?? parseSubagentUse(message)
  );
}
