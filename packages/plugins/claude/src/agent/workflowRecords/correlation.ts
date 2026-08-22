import { isGenericSubagentToolName } from '@happier-dev/plugin-sdk/sessions/subagents';

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
import { parseClaudeTaskNotification } from '../transcripts/taskNotification.js';

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

/**
 * The instant a raw Claude record carries, when it carries one.
 *
 * A replayed row already happened; stamping it with the clock of the process that reopened the
 * transcript dates every resumed workflow at the moment it was re-read. For a LIVE row the clock IS
 * its instant, so this reader is only consulted on the replay branch.
 */
export function readClaudeRecordTimestampMs(value: unknown): number | undefined {
  const raw = readRecord(value)?.timestamp;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  /** Structured Claude proof that this launch is a native Dynamic Workflow. */
  confirmedLocalWorkflow?: true;
  taskId?: string;
  /** Claude-native Workflow identity, stable across edit-and-resume tool invocations. */
  providerRunId?: string;
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

/**
 * The run's DURABLE record, replayed through the live stream's own `workflow_progress[]` vocabulary.
 *
 * A run-scoped fact rather than a lifecycle one: the record restates the run's structure, never its
 * ending. Its own `status` is deliberately ignored here so a backfill cannot move a run whose
 * outcome the transcript already decided.
 */
export type WorkflowRunRecordFact = Readonly<{
  kind: 'workflow-run-record';
  workflowToolUseId: string;
  workflowProgress: readonly WorkflowProgressEntryFact[];
  sourceSessionId?: string;
}>;

export type ClaudeWorkflowFact =
  | WorkflowStartFact
  | WorkflowLaunchFact
  | TaskLifecycleFact
  | SubagentStartFact
  | WorkflowJournalFact
  | WorkflowRunRecordFact;

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

/**
 * How this module says "the shape we depend on is gone".
 *
 * A plain message rather than an error object: nothing here failed, and there is nothing to retry.
 * The caller binds it to a signal that is ON BY DEFAULT — `logger.warn`, never `logger.debug`,
 * which is off in a session process and would make this report its own silent degradation.
 */
export type ClaudeWorkflowShapeDriftReporter = (message: string) => void;

/**
 * Drift signatures already reported by this process.
 *
 * `workflow_progress` is the roster's only live source and the Claude Agent SDK does NOT declare it:
 * `SDKTaskProgressMessage` declares `type/subtype/task_id/tool_use_id/description/usage/
 * last_tool_name/summary/uuid/session_id` and nothing more. So a provider-side rename or retype
 * ships with NO compile error, every reader below quietly stops matching, and the workflow roster
 * goes blank while the run itself is fine — precisely the silent degradation this corridor exists
 * to remove.
 *
 * Reported once per distinct signature because a `task_progress` tick fires throughout a run and a
 * per-tick warning would be its own defect. The set is bounded by the number of shapes, not by
 * traffic.
 */
const reportedWorkflowProgressShapeDrift = new Set<string>();

function reportWorkflowProgressShapeDrift(params: Readonly<{
  signature: string;
  detail: string;
  report: ClaudeWorkflowShapeDriftReporter | undefined;
}>): void {
  // Latched only once something can actually hear it, so an unwired parse cannot silence the
  // first wired one.
  if (!params.report) return;
  if (reportedWorkflowProgressShapeDrift.has(params.signature)) return;
  reportedWorkflowProgressShapeDrift.add(params.signature);
  params.report(
    `Claude workflow_progress is no longer readable (${params.detail}). `
    + 'This field is undeclared by the Claude Agent SDK, so a provider-side shape change cannot '
    + 'fail the build; workflow agent rosters will stay empty until the parser is updated.',
  );
}

function describeUnreadableWorkflowProgress(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function parseWorkflowProgress(
  value: unknown,
  report?: ClaudeWorkflowShapeDriftReporter,
): WorkflowProgressEntryFact[] | undefined {
  // A tick that ships no `workflow_progress` key at all is NORMAL and frequent — the live stream
  // throttles and a suppressed tick carries the field as absent. It says nothing about the roster,
  // and warning on it would drown the one case that matters.
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    reportWorkflowProgressShapeDrift({
      signature: `not-an-array:${describeUnreadableWorkflowProgress(value)}`,
      detail: `expected an array, received ${describeUnreadableWorkflowProgress(value)}`,
      report,
    });
    return undefined;
  }
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
  // An array that named nothing readable is indistinguishable, downstream, from a run with no
  // agents — so the array being non-empty is the only place that difference is still visible.
  if (facts.length === 0 && value.length > 0) {
    reportWorkflowProgressShapeDrift({
      signature: 'no-readable-entries',
      detail: `${value.length} entries carried no readable workflow_phase or workflow_agent`,
      report,
    });
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
    const transcriptDir =
      readString(toolUseResult?.transcriptDir)
      ?? readString(toolUseResult?.transcript_dir)
      ?? (() => {
        const match = contentText?.match(/Transcript dir:\s*([^\n]+)/);
        return readString(match?.[1]);
      })();

    const confirmedLocalWorkflow = taskType === 'local_workflow';
    const isWorkflowLaunch = confirmedLocalWorkflow
      || contentText?.includes('Workflow launched in background') === true
      || transcriptDir !== null;
    if (!isWorkflowLaunch) continue;

    const title = readString(toolUseResult?.workflowName) ?? readString(toolUseResult?.workflow_name);
    const summary = normalizeSummary(toolUseResult?.summary);
    const taskId = readString(toolUseResult?.taskId) ?? readString(toolUseResult?.task_id);
    const providerRunId = readString(toolUseResult?.runId) ?? readString(toolUseResult?.run_id);
    return {
      kind: 'workflow-launch',
      workflowToolUseId,
      ...(confirmedLocalWorkflow ? { confirmedLocalWorkflow: true } : {}),
      ...(taskId ? { taskId } : {}),
      ...(providerRunId ? { providerRunId } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(transcriptDir ? { transcriptDir } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(uuid ? { uuid } : {}),
    };
  }
  return null;
}

function parseSuccessfulWorkflowTaskStopResult(message: Record<string, unknown>): TaskLifecycleFact | null {
  if (message.type !== 'user') return null;
  const toolUseResult = readRecord(message.toolUseResult) ?? readRecord(message.tool_use_result);
  const taskType = readString(toolUseResult?.taskType) ?? readString(toolUseResult?.task_type);
  const taskId = readString(toolUseResult?.taskId) ?? readString(toolUseResult?.task_id);
  const resultMessage = readString(toolUseResult?.message);
  if (
    taskType !== 'local_workflow'
    || !taskId
    || !resultMessage?.startsWith(`Successfully stopped task: ${taskId}`)
  ) {
    return null;
  }
  const sourceSessionId = readSourceSessionId(message);
  const uuid = readString(message.uuid) ?? undefined;
  return {
    kind: 'task-lifecycle',
    subtype: 'workflow_task_stopped',
    taskId,
    taskType,
    status: 'cancelled',
    usage: {},
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(uuid ? { uuid } : {}),
  };
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
    // Which tool names ARE a generic sub-agent launch is the protocol's answer (`Task`/`Agent`/
    // `SubAgent`), not this parser's: Claude Code renamed the tool to `Agent`, and a private
    // `'Task'` literal here made every plain sub-agent invisible to the tracker — no start fact, no
    // implicit run, no roster row that could say `running`.
    if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !isGenericSubagentToolName(block.name)) continue;
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

/**
 * Parse the `<task-notification>` user message Claude Code persists when a backgrounded Workflow/Task
 * completes. This is the ONLY terminal lifecycle signal in the persisted transcript for backgrounded
 * runs (no `task_updated` row is written), so without it an explicit Workflow run never closes and the
 * work-state badge stays stuck "Running". It routes to the run via `<tool-use-id>` like a system
 * `task_*` event, so the tracker needs no change.
 */
function parseTaskNotificationEnvelope(message: Record<string, unknown>): TaskLifecycleFact | null {
  const notification = parseClaudeTaskNotification(message);
  if (!notification) return null;
  const { taskId, toolUseId } = notification;
  // Without a tool-use-id there is no correlation hook; do not synthesize a run.
  if (!toolUseId) return null;

  const status = normalizeClaudeActivityStatusSignal(notification.status, 'task_notification');
  const summary = normalizeSummary(notification.summary);
  const resultPreview = normalizeResultPreview(notification.result ?? notification.summary);
  const sourceSessionId = notification.sourceSessionId;
  const uuid = notification.uuid;

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

function parseTaskLifecycle(
  message: Record<string, unknown>,
  report?: ClaudeWorkflowShapeDriftReporter,
): TaskLifecycleFact | null {
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
  const workflowProgress = parseWorkflowProgress(message.workflow_progress, report);
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
const WORKFLOW_RUN_RECORD_WRAPPER_TYPE = 'happier_workflow_run_record';

/**
 * Feed the run's DURABLE record — `<sessionRoot>/workflows/<runId>.json` — through the same
 * `workflow_progress[]` fact path the live `task_progress` stream takes. One fact path, two sources.
 *
 * It carries what no other on-disk artifact does: each agent's `phaseIndex`/`phaseTitle`, the label
 * the script assigned it, its model, tokens, tool calls and duration. Crucially the runtime records
 * runtime VALUES, so a computed `label:` expression — which no scrape of the script source can
 * resolve — reads back correctly here.
 *
 * It is written ONCE, at terminal state. So this backfills a finished run; it can never drive a live
 * roster, and it cannot resolve an interrupted one.
 */
export function createClaudeWorkflowRunRecordWrapper(params: Readonly<{
  workflowToolUseId: string;
  workflowProgress: unknown;
  sourceSessionId?: string | undefined;
}>): Record<string, unknown> {
  return {
    type: WORKFLOW_RUN_RECORD_WRAPPER_TYPE,
    workflowToolUseId: params.workflowToolUseId,
    workflowProgress: params.workflowProgress,
    ...(params.sourceSessionId ? { sourceSessionId: params.sourceSessionId } : {}),
  };
}

function parseWorkflowRunRecordFact(
  message: Record<string, unknown>,
  report?: ClaudeWorkflowShapeDriftReporter,
): WorkflowRunRecordFact | null {
  if (message.type !== WORKFLOW_RUN_RECORD_WRAPPER_TYPE) return null;
  const workflowToolUseId = readString(message.workflowToolUseId);
  if (!workflowToolUseId) return null;
  const workflowProgress = parseWorkflowProgress(message.workflowProgress, report);
  if (!workflowProgress?.length) return null;
  const sourceSessionId = readString(message.sourceSessionId) ?? undefined;
  return {
    kind: 'workflow-run-record',
    workflowToolUseId,
    workflowProgress,
    ...(sourceSessionId ? { sourceSessionId } : {}),
  };
}

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
 *
 * `report` is optional because most callers only ask this parser a yes/no question about one shape
 * (the journal follower asks "is this a workflow launch?"). The caller that folds the whole live
 * stream — the tracker — supplies it, so an undeclared field going unreadable is observed exactly
 * once rather than at every reader that happens to look.
 */
export function parseClaudeWorkflowFact(
  value: unknown,
  report?: ClaudeWorkflowShapeDriftReporter,
): ClaudeWorkflowFact | null {
  const message = readRecord(value);
  if (!message) return null;
  return (
    parseTaskNotificationEnvelope(message)
    ?? parseWorkflowJournalFact(message)
    ?? parseWorkflowRunRecordFact(message, report)
    ?? parseSuccessfulWorkflowTaskStopResult(message)
    ?? parseWorkflowLaunchResult(message)
    ?? parseWorkflowToolUse(message)
    ?? parseTaskLifecycle(message, report)
    ?? parseSubagentUse(message)
  );
}
