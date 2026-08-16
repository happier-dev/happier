import {
  normalizeClaudeActivityStatusSignal,
  type ClaudeActivityStatusSignal,
} from '@happier-dev/protocol';
import { parseClaudeTaskNotificationXml } from '../taskNotifications/claudeTaskNotificationXml';

import {
  normalizeResultPreview,
  normalizeSummary,
  readModel,
  readTokensUsed,
  readToolCalls,
  readDurationSecondsFromMs,
  readUsageMetrics,
  type ClaudeWorkflowUsageMetrics,
} from './claudeWorkflowMetrics';

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

/**
 * The instant a Claude transcript/sidecar record carries, in ms — the record's own clock rather than
 * the moment something read it.
 *
 * One reader for the whole workflow corridor: the sidecar follower dates an agent's start and death
 * from it, and the activity source dates a replayed row from it, so a resumed session cannot stamp
 * hours-old work as fresh. Measured on the real 2 885-record transcript of session `15a64b1f`, every
 * `user`, `assistant` and `system` record carries one; absent means absent, and nothing is invented.
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
  /**
   * Set when the tool-use named a script FILE instead of inlining it (`Workflow {scriptPath}`).
   *
   * The tool has two input shapes and only `{script}` carries the text inline, so a `{scriptPath}`
   * launch has no phases and no agent labels until the file itself is read. The sidecar follower
   * owns that read and feeds the bytes back through `createClaudeWorkflowScriptWrapper`.
   */
  scriptPath?: string;
  sourceSessionId?: string;
  uuid?: string;
}>;

/** A `Workflow` async-launch tool result that exposes the sidecar transcript directory. */
export type WorkflowLaunchFact = Readonly<{
  kind: 'workflow-launch';
  workflowToolUseId: string;
  /**
   * True only for structured Claude SDK launch results whose native task type is `local_workflow`.
   * Textual launch hints are allowed to enrich an already-observed Workflow tool-use, but must not
   * synthesize a new run on their own because ordinary tool output can contain copied workflow text.
   */
  confirmedLocalWorkflow?: true;
  taskId?: string;
  /** Claude-native Workflow run identity, stable across edit-and-resume tool invocations. */
  providerRunId?: string;
  title?: string;
  summary?: string;
  transcriptDir?: string;
  /** The workflow script file the launch ran, when the tool was invoked by path. */
  scriptPath?: string;
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
  title: string;
  status: ClaudeActivityStatusSignal;
  vendorRef?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  resultPreview?: string;
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
  attempt?: number;
}>;

export type WorkflowProgressEntryFact = WorkflowProgressPhaseFact | WorkflowProgressAgentFact;

export type WorkflowJournalAgentSpecFact = Readonly<{
  label: string;
  phaseTitle?: string;
}>;

/**
 * What a workflow agent's OWN sidecar transcript says about itself.
 *
 * The journal is the only naming channel a running workflow agent has, and a `started` entry is
 * exactly `{type, key, agentId}` — a hex id and nothing else. The agent's own `agent-<id>.jsonl`
 * (its first prompt) and `agent-<id>.meta.json` (its model) sit in the directory the journal
 * follower already watches, so this fact carries the two things that directory can prove about an
 * otherwise anonymous agent.
 */
export type WorkflowAgentProfileFact = Readonly<{
  kind: 'workflow-agent-profile';
  workflowToolUseId: string;
  agentId: string;
  /** Bounded, single-line title the agent's prompt declares about itself; absent when it declares none. */
  title?: string;
  model?: string;
  /**
   * The sidechain its own transcript was IMPORTED under, when the importer accepted the file.
   *
   * The third thing that directory can prove about an anonymous agent, and the only one that is a
   * capability rather than a description: it is what lets a client open the agent. Absent means no
   * transcript was imported — never "not yet" — so a row built from this fact stays unopenable.
   */
  sidechainId?: string;
  /**
   * When the agent's own transcript says it started — its first record's timestamp.
   *
   * The journal carries no time at all, so without this a start time is only the moment the CLI
   * happened to notice the agent. This is the agent's own clock, and the follower already parses
   * exactly the record it comes from.
   */
  startedAt?: number;
  /**
   * The agent's transcript ENDS in a terminal API error (auth, rate limit, org policy).
   *
   * The one death that happens while the owning process is still alive and the run is still open,
   * so neither a stop nor a resume can ever reach it. It is an observation — the last record of a
   * file the follower already reads — which is what makes resolving the row honest rather than an
   * inference from silence.
   */
  endedByApiError?: boolean;
  /** The last instant that transcript evidences. Never a fabricated end. */
  endedAt?: number;
  sourceSessionId?: string;
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
 * The `tool_result` for a previously observed `Task` tool-use — a plain subagent finishing.
 *
 * A backgrounded subagent also emits `task_notification`/`task_updated`, but a SYNCHRONOUS one
 * emits nothing except this result, so without it a plain subagent stays `active` forever. The
 * tracker only applies it to tool-use ids it has already seen as `subagent-start`, so an unrelated
 * tool result can never close an agent.
 */
export type SubagentResultFact = Readonly<{
  kind: 'subagent-result';
  toolUseId: string;
  status: Extract<ClaudeActivityStatusSignal, 'complete' | 'failed'>;
  summary?: string;
  resultPreview?: string;
  timeUsedSeconds?: number;
  sourceSessionId?: string;
  uuid?: string;
}>;

/**
 * The run's durable on-disk record, carrying the SAME `workflow_progress[]` the live stream carries.
 *
 * A distinct fact rather than a synthesized `task-lifecycle`, because it must NOT be allowed to move
 * the run's status: it is read at an arbitrary later moment (a resume, a reconcile), and a run's
 * status is owned by its own lifecycle events. All it contributes is structure and metrics.
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
  | SubagentResultFact
  | WorkflowAgentProfileFact
  | WorkflowRunRecordFact
  | WorkflowJournalFact;

const TASK_LIFECYCLE_SUBTYPES = new Set([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
]);

function readScriptWorkflowName(script: string): string | null {
  const match = script.match(/name:\s*['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}

function readWorkflowName(input: Record<string, unknown> | null): string | null {
  // `Workflow {script}` carries the workflow name in the script's `meta.name`; fall back to a
  // description if present. Avoids storing raw scripts in the snapshot.
  const description = readString(input?.description);
  if (description) return description;
  const script = readString(input?.script);
  if (script) return readScriptWorkflowName(script);
  return null;
}

function readScriptWorkflowPhases(script: string): WorkflowProgressPhaseFact[] | undefined {
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

function readWorkflowPhases(input: Record<string, unknown> | null): WorkflowProgressPhaseFact[] | undefined {
  const script = readString(input?.script);
  return script ? readScriptWorkflowPhases(script) : undefined;
}

function readScriptWorkflowJournalAgentSpecs(script: string): WorkflowJournalAgentSpecFact[] | undefined {
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

function readWorkflowJournalAgentSpecs(input: Record<string, unknown> | null): WorkflowJournalAgentSpecFact[] | undefined {
  const script = readString(input?.script);
  return script ? readScriptWorkflowJournalAgentSpecs(script) : undefined;
}

/**
 * Which identifier a `workflow_progress[]` entry names its agent by.
 *
 * The two sources of this array disagree about what is knowable WHEN, so one policy cannot serve
 * both:
 *
 * - `provisionalIndex` — the LIVE `task_progress` stream. It emits an agent before that agent has a
 *   provider id at all, so the position is the only stable identity available and the concrete id
 *   arrives later as `vendorRef` (pinned by "merges provisional index-only workflow agents with
 *   later concrete agent ids").
 * - `agentId` — the durable run record on disk. It is written once, at terminal state, and carries
 *   the concrete id for every agent. Here the position must NOT win: the journal has already created
 *   these agents under their real ids, so keying by position would file a SECOND row for each one and
 *   publish fourteen agents for a seven-agent run.
 *
 * One parser, one output shape, one documented switch on provenance — not a second reader.
 */
type WorkflowProgressAgentIdentity = 'provisionalIndex' | 'agentId';

function parseWorkflowProgress(
  value: unknown,
  identity: WorkflowProgressAgentIdentity = 'provisionalIndex',
): WorkflowProgressEntryFact[] | undefined {
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
      const index = readNumber(record.index);
      const agentId = readString(record.agentId);
      const provisionalId = index !== undefined ? `workflow-agent:${Math.trunc(index)}` : undefined;
      const id = identity === 'agentId'
        ? agentId ?? provisionalId ?? readString(record.label)
        : provisionalId ?? agentId ?? readString(record.label);
      if (!id) continue;
      const title = readString(record.label) ?? agentId ?? id;
      const status = normalizeClaudeActivityStatusSignal(record.state);
      const phaseIndex = readNumber(record.phaseIndex);
      const phaseTitle = readString(record.phaseTitle);
      const model = readModel(record.model);
      const resultPreview = normalizeResultPreview(record.resultPreview);
      const tokensUsed = readTokensUsed(record.tokens);
      const toolCalls = readToolCalls(record.toolCalls);
      const timeUsedSeconds = readDurationSecondsFromMs(record.durationMs);
      const attempt = readNumber(record.attempt);
      facts.push({
        kind: 'agent',
        id,
        title,
        status,
        ...(agentId ? { vendorRef: agentId } : {}),
        ...(phaseIndex !== undefined ? { phaseIndex } : {}),
        ...(phaseTitle ? { phaseTitle } : {}),
        ...(model ? { model } : {}),
        ...(resultPreview ? { resultPreview } : {}),
        ...(tokensUsed !== undefined ? { tokensUsed } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
        ...(attempt !== undefined ? { attempt: Math.trunc(attempt) } : {}),
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
    const scriptPath = readString(input?.scriptPath) ?? readString(input?.script_path);
    return {
      kind: 'workflow-start',
      workflowToolUseId: id,
      title,
      ...(phases ? { phases } : {}),
      ...(journalAgentSpecs ? { journalAgentSpecs } : {}),
      ...(scriptPath ? { scriptPath } : {}),
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

function normalizeWorkflowToolResultErrorPreview(contentText: string | null): string | undefined {
  if (!contentText) return undefined;
  const xmlMatch = contentText.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/);
  return normalizeResultPreview(xmlMatch?.[1] ?? contentText);
}

function parseFailedWorkflowToolResult(message: Record<string, unknown>): TaskLifecycleFact | null {
  if (message.type !== 'user') return null;
  const nested = readRecord(message.message);
  const content = nested?.content;
  if (!Array.isArray(content)) return null;

  const sourceSessionId = readSourceSessionId(message);
  const uuid = readString(message.uuid) ?? undefined;
  for (const part of content) {
    const block = readRecord(part);
    if (block?.type !== 'tool_result') continue;
    const toolUseId = readString(block.tool_use_id);
    if (!toolUseId) continue;
    const contentText = readToolResultContentText(block);
    const hasToolUseErrorEnvelope = contentText?.includes('<tool_use_error>') === true;
    if (block.is_error !== true && !hasToolUseErrorEnvelope) continue;
    const resultPreview = normalizeWorkflowToolResultErrorPreview(contentText);
    return {
      kind: 'task-lifecycle',
      subtype: 'workflow_tool_result',
      toolUseId,
      status: 'failed',
      ...(resultPreview ? { resultPreview } : {}),
      usage: {},
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(uuid ? { uuid } : {}),
    };
  }
  return null;
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
    const scriptPath = readString(toolUseResult?.scriptPath) ?? readString(toolUseResult?.script_path);
    return {
      kind: 'workflow-launch',
      workflowToolUseId,
      ...(confirmedLocalWorkflow ? { confirmedLocalWorkflow: true } : {}),
      ...(taskId ? { taskId } : {}),
      ...(providerRunId ? { providerRunId } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(transcriptDir ? { transcriptDir } : {}),
      ...(scriptPath ? { scriptPath } : {}),
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

function parseSubagentToolUse(message: Record<string, unknown>): SubagentStartFact | null {
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

/**
 * Parse a NON-error `tool_result` as a plain-subagent completion.
 *
 * A synchronous `Task` subagent emits no lifecycle system event at all — the tool result is its only
 * terminal evidence — while the error case is already covered upstream by
 * `parseFailedWorkflowToolResult`. A successful `Task` result is byte-indistinguishable from a
 * successful `Read`/`Bash` result, so identity comes from the caller's correlation state rather than
 * from the payload shape: without `isKnownSubagentToolUseId` this parser yields nothing, keeping the
 * module contract "null unless workflow-relevant" intact. Guessing at the result shape would drift
 * with the SDK; the id gate cannot.
 */
function parseSubagentToolResult(
  message: Record<string, unknown>,
  isKnownSubagentToolUseId: ((toolUseId: string) => boolean) | undefined,
): SubagentResultFact | null {
  if (!isKnownSubagentToolUseId) return null;
  if (message.type !== 'user') return null;
  const nested = readRecord(message.message);
  const content = nested?.content;
  if (!Array.isArray(content)) return null;

  const sourceSessionId = readSourceSessionId(message);
  const uuid = readString(message.uuid) ?? undefined;
  const toolUseResult = readRecord(message.toolUseResult) ?? readRecord(message.tool_use_result);
  const timeUsedSeconds = readDurationSecondsFromMs(
    toolUseResult?.totalDurationMs ?? toolUseResult?.total_duration_ms,
  );

  for (const part of content) {
    const block = readRecord(part);
    if (block?.type !== 'tool_result') continue;
    if (block.is_error === true) continue;
    const toolUseId = readString(block.tool_use_id);
    if (!toolUseId || !isKnownSubagentToolUseId(toolUseId)) continue;
    const resultPreview = normalizeResultPreview(readToolResultContentText(block));
    return {
      kind: 'subagent-result',
      toolUseId,
      status: 'complete',
      ...(resultPreview ? { resultPreview } : {}),
      ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(uuid ? { uuid } : {}),
    };
  }
  return null;
}

/**
 * Parse the `<task-notification>` XML Claude Code persists when a backgrounded Workflow/Task
 * completes. Real persisted rows can arrive as `user` text, `queue-operation.content`, or a
 * `queued_command` attachment prompt. It routes to the run through `<tool-use-id>`.
 */
function parseTaskNotificationMessage(message: Record<string, unknown>): TaskLifecycleFact | null {
  const parsed = parseClaudeTaskNotificationXml(message);
  if (!parsed) return null;
  // Without a tool-use-id there is no correlation hook; do not synthesize a run.
  if (!parsed.toolUseId) return null;

  const status = normalizeClaudeActivityStatusSignal(parsed.status, 'task_notification');
  const summary = normalizeSummary(parsed.summary);
  const resultPreview = normalizeResultPreview(parsed.result ?? parsed.summary);

  return {
    kind: 'task-lifecycle',
    subtype: 'task_notification',
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    toolUseId: parsed.toolUseId,
    status,
    ...(summary ? { summary } : {}),
    ...(resultPreview ? { resultPreview } : {}),
    usage: {},
    ...(parsed.sourceSessionId ? { sourceSessionId: parsed.sourceSessionId } : {}),
    ...(parsed.uuid ? { uuid: parsed.uuid } : {}),
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
  const sourceSessionId = readSourceSessionId(message);

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
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(startedAt !== undefined ? { startedAt: Math.trunc(startedAt) } : {}),
    ...(completedAt !== undefined ? { completedAt: Math.trunc(completedAt) } : {}),
    ...(workflowProgress ? { workflowProgress } : {}),
    ...(readString(message.uuid) ? { uuid: readString(message.uuid) as string } : {}),
  };
}

const WORKFLOW_JOURNAL_WRAPPER_TYPE = 'happier_workflow_journal';
const WORKFLOW_SCRIPT_WRAPPER_TYPE = 'happier_workflow_script';
const WORKFLOW_AGENT_PROFILE_WRAPPER_TYPE = 'happier_workflow_agent_profile';
const WORKFLOW_RUN_RECORD_WRAPPER_TYPE = 'happier_workflow_run_record';

/**
 * Feed the run's DURABLE record — `<claudeProjectDir>/<sessionId>/workflows/<runId>.json` — through
 * the same `workflow_progress[]` fact path the live `task_progress` stream takes.
 *
 * It carries what no other on-disk artifact does: each agent's `phaseIndex`/`phaseTitle`, the label
 * the script assigned it, its model, tokens, tool calls and duration. Measured on the real run
 * `wf_e1bd2111-9e1`: 7 agents, `phaseIndex` 1×6 + 2×1, every `agentId` matching the journal's.
 *
 * It is written ONCE, at terminal state — verified across the 51 runs of session `b4416eda`: 458
 * agent states, none of them non-terminal, and two runs that started but never finished have no
 * record at all. So this backfills a finished run; it can never drive a live roster, and it cannot
 * resolve an interrupted one.
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

/**
 * Feed a workflow script read from disk back through the SAME fact path an inline `{script}`
 * tool-use takes, so a `{scriptPath}` launch produces the same phases and agent label specs.
 */
export function createClaudeWorkflowScriptWrapper(params: Readonly<{
  workflowToolUseId: string;
  script: string;
  sourceSessionId?: string | undefined;
}>): Record<string, unknown> {
  return {
    type: WORKFLOW_SCRIPT_WRAPPER_TYPE,
    workflowToolUseId: params.workflowToolUseId,
    script: params.script,
    ...(params.sourceSessionId ? { sourceSessionId: params.sourceSessionId } : {}),
  };
}

/** Feed what one workflow agent's own sidecar directory proves about it into the tracker. */
export function createClaudeWorkflowAgentProfileWrapper(params: Readonly<{
  workflowToolUseId: string;
  agentId: string;
  prompt?: string | undefined;
  model?: string | undefined;
  sidechainId?: string | undefined;
  startedAt?: number | undefined;
  endedByApiError?: boolean | undefined;
  endedAt?: number | undefined;
  sourceSessionId?: string | undefined;
}>): Record<string, unknown> {
  return {
    type: WORKFLOW_AGENT_PROFILE_WRAPPER_TYPE,
    workflowToolUseId: params.workflowToolUseId,
    agentId: params.agentId,
    ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.sidechainId !== undefined ? { sidechainId: params.sidechainId } : {}),
    ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
    ...(params.endedByApiError ? { endedByApiError: true } : {}),
    ...(params.endedAt !== undefined ? { endedAt: params.endedAt } : {}),
    ...(params.sourceSessionId ? { sourceSessionId: params.sourceSessionId } : {}),
  };
}

/** A row title must stay a title: bounded and single-line, never a prompt dump. */
export const WORKFLOW_AGENT_PROMPT_TITLE_MAX = 160;

/**
 * The lane a workflow-agent prompt declares about ITSELF — the only prompt-derived title worth
 * asserting.
 *
 * Measured over 280 real multi-agent workflow runs in this machine's Claude transcript corpus
 * (1 590 agents): the prompt's FIRST LINE is unique across siblings in only 15% of runs, so titling
 * by prompt head would paint N identical rows in the other 85% — worse than distinct ordinals. Two
 * self-declarations do carry the agent's own identity: a lane/unit marker line, and failing that the
 * first level-1 markdown heading (shared program preamble is written at `##`, the lane's own heading
 * at `#`). Together they name 53% of agents and collide across siblings in 41 of 280 runs. Where a
 * prompt declares neither, this returns nothing and the caller keeps its stable ordinal.
 */
const WORKFLOW_AGENT_PROMPT_MARKER_WORDS = ['LANE', 'UNIT', 'PACKET', 'TASK', 'ROLE', 'MISSION'] as const;

/** Any line opening with a marker word, in any case — the weakest evidence a prompt can offer. */
const WORKFLOW_AGENT_PROMPT_LANE_MARKER = new RegExp(
  `^[#*_>\\s-]*(?:YOUR\\s+)?(?:${WORKFLOW_AGENT_PROMPT_MARKER_WORDS.join('|')})\\b`,
  'i',
);

/**
 * A marker line written as a LABEL rather than as a sentence: the marker word as a word (`LANE`,
 * `Lane` — never a mid-sentence `lane`), an optional short id run (`UI`, `L30`, `(G4)`, `IDS`), then
 * a separator, then the name it declares.
 *
 * A sentence that merely begins with a marker word is not a self-declaration: over the same corpus
 * (4 292 sidecar prompts re-derived) `Lane reports are in /Users/…`, `Lane docs to read: …` and
 * `- Task↔PR: …` each titled rows with a truncated path or a quoted fact while the prompt's own
 * heading sat unused. Prose fails this shape — its first token after the marker word is a
 * lowercase English word — so a declared heading now wins instead. The id run rejects nothing on its
 * own; it exists so `LANE UI — …` and `LANE (BLOCKER — G1): …` still read as declarations.
 *
 * Case matters here and the `i` flag must NOT come back: under `i`, `[^\s a-z]` folds to "not a
 * letter" and would reject every uppercase id, which silently disables the whole id run.
 */
const WORKFLOW_AGENT_PROMPT_SELF_DECLARATION = new RegExp(
  `^[#*_>\\s-]*(?:(?:YOUR|Your)\\s+)?(?:${WORKFLOW_AGENT_PROMPT_MARKER_WORDS
    .flatMap((word) => [word, `${word.charAt(0)}${word.slice(1).toLowerCase()}`])
    .join('|')})\\b(?:\\s+[^\\sa-z]\\S*){0,3}(?::|\\s+[:—–·|-])\\s*\\S`,
);

const WORKFLOW_AGENT_PROMPT_TOP_HEADING = /^#\s+\S/;

function normalizeWorkflowAgentPromptTitle(line: string): string | undefined {
  const cleaned = line
    .replace(/^[#*_>\s-]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > WORKFLOW_AGENT_PROMPT_TITLE_MAX
    ? cleaned.slice(0, WORKFLOW_AGENT_PROMPT_TITLE_MAX).trimEnd()
    : cleaned;
}

/**
 * Ranked, best first: a lane the prompt declares as a label, then the heading it declares, then any
 * line merely opening with a marker word. The last rank keeps every title this ever produced — a
 * prompt whose only evidence is prose still names its row rather than falling back to an ordinal.
 */
export function deriveWorkflowAgentPromptTitle(prompt: unknown): string | undefined {
  if (typeof prompt !== 'string') return undefined;
  let topHeading: string | undefined;
  let markerLine: string | undefined;
  for (const rawLine of prompt.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (WORKFLOW_AGENT_PROMPT_SELF_DECLARATION.test(line)) {
      const declared = normalizeWorkflowAgentPromptTitle(line);
      if (declared) return declared;
    }
    if (markerLine === undefined && WORKFLOW_AGENT_PROMPT_LANE_MARKER.test(line)) {
      markerLine = normalizeWorkflowAgentPromptTitle(line);
    }
    if (topHeading === undefined && WORKFLOW_AGENT_PROMPT_TOP_HEADING.test(line)) {
      topHeading = normalizeWorkflowAgentPromptTitle(line);
    }
  }
  return topHeading ?? markerLine;
}

function parseWorkflowScriptFact(message: Record<string, unknown>): WorkflowStartFact | null {
  if (message.type !== WORKFLOW_SCRIPT_WRAPPER_TYPE) return null;
  const workflowToolUseId = readString(message.workflowToolUseId);
  const script = readString(message.script);
  if (!workflowToolUseId || !script) return null;
  const phases = readScriptWorkflowPhases(script);
  const journalAgentSpecs = readScriptWorkflowJournalAgentSpecs(script);
  const sourceSessionId = readString(message.sourceSessionId) ?? undefined;
  return {
    kind: 'workflow-start',
    workflowToolUseId,
    title: readScriptWorkflowName(script) ?? 'Workflow',
    ...(phases ? { phases } : {}),
    ...(journalAgentSpecs ? { journalAgentSpecs } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
  };
}

function parseWorkflowRunRecordFact(message: Record<string, unknown>): WorkflowRunRecordFact | null {
  if (message.type !== WORKFLOW_RUN_RECORD_WRAPPER_TYPE) return null;
  const workflowToolUseId = readString(message.workflowToolUseId);
  if (!workflowToolUseId) return null;
  // Keyed by the concrete agent id: the journal already created these agents under it, and the
  // record — being terminal — always has one.
  const workflowProgress = parseWorkflowProgress(message.workflowProgress, 'agentId');
  if (!workflowProgress?.length) return null;
  const sourceSessionId = readString(message.sourceSessionId) ?? undefined;
  return {
    kind: 'workflow-run-record',
    workflowToolUseId,
    workflowProgress,
    ...(sourceSessionId ? { sourceSessionId } : {}),
  };
}

function parseWorkflowAgentProfileFact(message: Record<string, unknown>): WorkflowAgentProfileFact | null {
  if (message.type !== WORKFLOW_AGENT_PROFILE_WRAPPER_TYPE) return null;
  const workflowToolUseId = readString(message.workflowToolUseId);
  const agentId = readString(message.agentId);
  if (!workflowToolUseId || !agentId) return null;
  const title = deriveWorkflowAgentPromptTitle(message.prompt);
  const model = readModel(message.model);
  const sidechainId = readString(message.sidechainId) ?? undefined;
  const startedAt = readNumber(message.startedAt);
  const endedByApiError = message.endedByApiError === true;
  const endedAt = readNumber(message.endedAt);
  const sourceSessionId = readString(message.sourceSessionId) ?? undefined;
  return {
    kind: 'workflow-agent-profile',
    workflowToolUseId,
    agentId,
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(sidechainId ? { sidechainId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedByApiError ? { endedByApiError } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
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

/**
 * The journal outranks every title we derive ourselves (RULING-13), so its fields carry the same
 * ceiling the prompt path already applies — an agent that reports a paragraph as its `lane` names
 * its row, it does not dump into it. Observed: 14 of 3 671 real journal results exceed the bound,
 * the longest at 2 266 characters.
 *
 * Only the length is corrected. Real journal titles are single-line (0 of 3 671 carry a newline
 * inside their first {@link WORKFLOW_AGENT_PROMPT_TITLE_MAX} characters); a multi-line one would
 * still reach a row, and is the observation that would justify collapsing whitespace here too.
 */
function readBoundedJournalTitle(value: unknown): string | undefined {
  const text = readString(value);
  if (!text) return undefined;
  return text.length > WORKFLOW_AGENT_PROMPT_TITLE_MAX
    ? text.slice(0, WORKFLOW_AGENT_PROMPT_TITLE_MAX).trimEnd()
    : text;
}

function readJournalResultTitle(result: Record<string, unknown> | null, fallback: string): string {
  return readBoundedJournalTitle(result?.lane)
    ?? readBoundedJournalTitle(result?.label)
    ?? readBoundedJournalTitle(result?.item)
    ?? readBoundedJournalTitle(result?.message)
    // The fallback is the agent id: left verbatim so the tracker can still recognise an opaque title.
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

export type ClaudeWorkflowFactParseContext = Readonly<{
  /**
   * Correlation state owned by the tracker: tool-use ids already observed as `subagent-start`.
   * Required to recognise a successful subagent `tool_result`, which is payload-identical to every
   * other successful tool result. Absent => that fact is never produced.
   */
  isKnownSubagentToolUseId?: (toolUseId: string) => boolean;
}>;

/**
 * Parse one raw transcript value into a workflow fact, or `null` if it carries no workflow-relevant
 * signal. The tracker decides routing/promotion; this only extracts shapes.
 */
export function parseClaudeWorkflowFact(
  value: unknown,
  context?: ClaudeWorkflowFactParseContext,
): ClaudeWorkflowFact | null {
  const message = readRecord(value);
  if (!message) return null;
  return (
    parseTaskNotificationMessage(message)
    ?? parseWorkflowJournalFact(message)
    ?? parseWorkflowScriptFact(message)
    ?? parseWorkflowRunRecordFact(message)
    ?? parseWorkflowAgentProfileFact(message)
    ?? parseFailedWorkflowToolResult(message)
    ?? parseSuccessfulWorkflowTaskStopResult(message)
    ?? parseWorkflowLaunchResult(message)
    ?? parseWorkflowToolUse(message)
    ?? parseTaskLifecycle(message)
    ?? parseSubagentToolUse(message)
    ?? parseSubagentToolResult(message, context?.isKnownSubagentToolUseId)
  );
}
