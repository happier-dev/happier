import { RawJSONLinesSchema, type RawJSONLines } from './rawJsonLines.js';
import { isGenericSubagentToolName } from '@happier-dev/plugin-sdk/sessions/subagents';

import { isClaudeAsyncAgentLaunchToolResult, normalizeClaudeActivityStatusSignal, type ClaudeActivityStatusSignal } from '../activityStatus.js';
import { readClaudeTranscriptProviderSessionId } from '../../protocol/providerIdentity.js';
import { readClaudeNativePeerMessage, withClaudeNativeToolResultMetadata } from './nativeSemanticProjection.js';

export type ClaudeTaskNotification = Readonly<{
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
  result: string | null;
  sourceSessionId?: string;
  uuid?: string;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTextContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const texts: string[] = [];
  for (const item of value) {
    const text = readString(readRecord(item)?.text);
    if (text) texts.push(text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

function readEnvelopeText(row: Record<string, unknown>): string | null {
  if (row.type === 'user') {
    return readTextContent(readRecord(row.message)?.content);
  }
  if (row.type === 'queue-operation' && row.operation === 'enqueue') {
    return readTextContent(row.content);
  }
  if (row.type === 'attachment') {
    const attachment = readRecord(row.attachment);
    return attachment?.type === 'queued_command'
      ? readString(attachment.prompt)
      : null;
  }
  return null;
}

function readXmlTag(source: string, tag: string): string | null {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] !== undefined ? readString(match[1]) : null;
}

export function parseClaudeTaskNotification(value: unknown): ClaudeTaskNotification | null {
  const row = readRecord(value);
  if (!row) return null;
  const text = readEnvelopeText(row);
  if (!text || !/^\s*<task-notification\b/i.test(text)) return null;

  const sourceSessionId = readClaudeTranscriptProviderSessionId(row) ?? undefined;
  const uuid = readString(row.uuid) ?? undefined;
  return {
    taskId: readXmlTag(text, 'task-id'),
    toolUseId: readXmlTag(text, 'tool-use-id'),
    status: readXmlTag(text, 'status'),
    summary: readXmlTag(text, 'summary'),
    result: readXmlTag(text, 'result'),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(uuid ? { uuid } : {}),
  };
}

export type ClaudeTaskLifecycleEnvelope = Readonly<{
  subtype: 'task_started' | 'task_notification' | 'task_status' | 'handback' | 'agent-resume' | 'async-launch';
  taskId: string | null;
  toolUseId: string | null;
  status: ClaudeActivityStatusSignal;
  resumed?: true;
  knownOnly?: true;
  taskType?: string;
  summary?: string;
  result?: string;
  sourceSessionId?: string;
  uuid?: string;
}>;

/** Native transcript envelopes share one identity/status reader across runtime and history. */
export function readClaudeTaskLifecycleEnvelope(value: unknown): ClaudeTaskLifecycleEnvelope | null {
  const row = readRecord(value);
  if (!row || row.type === 'queue-operation') return null;
  const attachment = row.type === 'attachment' ? readRecord(row.attachment) : null;
  const origin = readRecord(row.origin) ?? (attachment?.type === 'queued_command' ? readRecord(attachment.origin) : null);
  const sourceSessionId = readClaudeTranscriptProviderSessionId(row) ?? undefined;
  const uuid = readString(row.uuid) ?? undefined;
  const identity = {
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(uuid ? { uuid } : {}),
  };
  const hookName = readString(row.hook_event_name ?? row.hookEventName ?? row.eventName);
  if (row.type === 'system' && row.subtype === 'task_started') {
    const taskId = readString(row.task_id);
    return taskId ? { subtype: 'task_started', taskId, toolUseId: readString(row.tool_use_id), status: 'active', ...identity } : null;
  }
  if (row.type === 'system' && row.subtype === 'task_notification') {
    const taskId = readString(row.task_id);
    if (!taskId) return null;
    return { subtype: 'task_notification', taskId, toolUseId: readString(row.tool_use_id),
      status: normalizeClaudeActivityStatusSignal(row.status, 'task_notification'),
      ...(readString(row.summary) ? { summary: readString(row.summary)! } : {}), ...identity };
  }
  if (hookName === 'SubagentStart') {
    const taskId = readString(row.agent_id ?? row.agentId);
    return taskId ? { subtype: 'agent-resume', taskId, toolUseId: null, status: 'active',
      resumed: true, knownOnly: true, ...identity } : null;
  }
  const response = row.type === 'user' ? readRecord(row.toolUseResult ?? row.tool_use_result) : null;
  const hookResponse = hookName === 'PostToolUse' ? readRecord(row.tool_response ?? row.toolResponse ?? row.toolUseResult ?? row.tool_use_result) : null;
  const toolName = readString(row.tool_name ?? row.toolName);
  const resumeResponse = hookName === 'PostToolUse' && toolName === 'SendMessage' ? hookResponse : response;
  // Claude 2.1.296 explicitly reports a user-stopped Agent when SendMessage cannot
  // resume it. This is settled native task evidence, not a generic delivery failure.
  if (resumeResponse?.success === false) {
    const cancelledAgentId = /^Agent (\S+) was stopped by the user and won't be resumed\./
      .exec(readString(resumeResponse.message) ?? '')?.[1];
    const content = readRecord(row.message)?.content;
    const nativeToolResult = Array.isArray(content)
      && content.map(readRecord).some(block => block?.type === 'tool_result' && readString(block.tool_use_id));
    const hookInput = readRecord(row.tool_input ?? row.toolInput);
    const matchingHookTarget = hookName === 'PostToolUse' && toolName === 'SendMessage'
      && readString(hookInput?.to) === cancelledAgentId;
    if (cancelledAgentId && (hookName === 'PostToolUse'
      ? matchingHookTarget : row.type === 'user' && nativeToolResult)) {
      return { subtype: 'task_status', taskId: cancelledAgentId, toolUseId: null, status: 'cancelled',
        summary: readString(resumeResponse.message)!, ...identity };
    }
  }
  const resumedAgentId = readString(resumeResponse?.resumedAgentId ?? resumeResponse?.resumed_agent_id);
  if (resumedAgentId && resumeResponse && resumeResponse.success !== false && resumeResponse.is_error !== true
    && resumeResponse.isError !== true && resumeResponse.error == null
    && !['failed', 'error', 'denied', 'rejected'].includes(readString(resumeResponse.status)?.toLowerCase() ?? '')) {
    // Claude returns this field only for detached asynchronous resumes, even for a formerly foreground child.
    return { subtype: 'agent-resume', taskId: resumedAgentId, toolUseId: null, status: 'active', resumed: true, ...identity };
  }
  const asyncResponse = hookResponse && toolName && (isGenericSubagentToolName(toolName) || toolName === 'Workflow')
    ? hookResponse : response;
  if (isClaudeAsyncAgentLaunchToolResult(asyncResponse)) {
    const taskId = readString(asyncResponse?.agentId ?? asyncResponse?.agent_id ?? asyncResponse?.taskId ?? asyncResponse?.task_id);
    const content = readRecord(row.message)?.content;
    const result = Array.isArray(content) ? content.map(readRecord).find(block => block?.type === 'tool_result') : null;
    if (result?.is_error === true || asyncResponse?.success === false || asyncResponse?.is_error === true
      || asyncResponse?.isError === true || asyncResponse?.error != null) return null;
    const toolUseId = readString(row.tool_use_id ?? row.toolUseId) ?? readString(result?.tool_use_id);
    return { subtype: 'async-launch', taskId, toolUseId, status: 'active', ...identity };
  }
  if (attachment?.type === 'task_status') {
    const taskId = readString(attachment.taskId ?? attachment.task_id);
    if (!taskId) return null;
    const taskType = readString(attachment.taskType ?? attachment.task_type);
    return {
      subtype: 'task_status',
      taskId,
      toolUseId: readString(attachment.toolUseId ?? attachment.tool_use_id) ?? readString(readRecord(attachment.shell)?.toolUseId),
      status: normalizeClaudeActivityStatusSignal(attachment.status),
      ...(taskType ? { taskType } : {}),
      ...identity,
    };
  }
  if ((row.type === 'user' || attachment?.type === 'queued_command') && origin?.kind === 'peer' && origin.handback === true) {
    const taskId = readString(origin.senderTaskId) ?? readString(origin.from);
    // SubagentHandback delivers a report before execution necessarily settles (Claude 2.1.291).
    return taskId ? { subtype: 'handback', taskId, toolUseId: null, status: 'active', ...identity } : null;
  }
  // Native delivery preserves origin, or queued_command preserves its native mode. Bare
  // queue-operation strings also contain ordinary prompts and carry no lifecycle authority.
  const nativeNotification = origin?.kind === 'task-notification'
    || (attachment?.type === 'queued_command' && attachment.commandMode === 'task-notification');
  if (!nativeNotification) return null;
  const xml = parseClaudeTaskNotification(value);
  const notificationOrigin = origin?.kind === 'task-notification' ? origin : null;
  if (!xml && !notificationOrigin) return null;
  const summary = readString(notificationOrigin?.summary) ?? xml?.summary;
  const result = readString(notificationOrigin?.result) ?? xml?.result;
  return {
    subtype: 'task_notification',
    taskId: readString(notificationOrigin?.taskId ?? notificationOrigin?.task_id) ?? xml?.taskId ?? null,
    toolUseId: readString(notificationOrigin?.toolUseId ?? notificationOrigin?.tool_use_id) ?? xml?.toolUseId ?? null,
    status: normalizeClaudeActivityStatusSignal(notificationOrigin?.status ?? xml?.status, 'task_notification'),
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
    ...identity,
  };
}

/** Native notifications and task-status responses share the same conversation outcome owner. */
export function isClaudeTaskLifecycleResultEnvelope(envelope: ClaudeTaskLifecycleEnvelope | null): envelope is ClaudeTaskLifecycleEnvelope {
  return envelope?.subtype === 'task_notification' || envelope?.subtype === 'task_status';
}

/** Project an authenticated settled lifecycle fact onto its original conversation tool call. */
export function projectClaudeTaskLifecycleToolResult(value: unknown, correlatedToolUseId?: string | null,
  observedSidechain?: Readonly<{ sidechainId: string }>, report?: string): RawJSONLines | null {
  const row = readRecord(value);
  const notification = readClaudeTaskLifecycleEnvelope(value);
  if (!row || (row.isSidechain === true && !observedSidechain) || !isClaudeTaskLifecycleResultEnvelope(notification)
    || !['complete', 'failed', 'cancelled'].includes(notification.status)) return null;
  if (observedSidechain && readString(row.sidechainId) && readString(row.sidechainId) !== observedSidechain.sidechainId) return null;
  const toolUseId = notification.toolUseId ?? correlatedToolUseId;
  if (!toolUseId || !readString(row.uuid)) return null;
  const result = report ?? notification.result ?? notification.summary ?? notification.status;
  const content = readRecord(row.message)?.content;
  const existingResult = Array.isArray(content) ? content.map(readRecord).find(block =>
    block?.type === 'tool_result' && readString(block.tool_use_id) === toolUseId) : null;
  // A stopped SendMessage response also proves its child's outcome. Retain its
  // original result and native metadata on that block, not on the child's report.
  const ownContent = Array.isArray(content) ? content.filter(block => {
    const result = readRecord(block);
    return result?.type !== 'tool_result' || readString(result.tool_use_id) !== toolUseId;
  }).map(block => {
    const result = readRecord(block);
    return result?.type === 'tool_result'
      ? { ...result, content: withClaudeNativeToolResultMetadata(result.content, row) } : block;
  }) : [];
  const hasOwnContent = ownContent.length > 0;
  const nativeOrigin = readRecord(row.origin) ?? readRecord(readRecord(row.attachment)?.origin);
  const { attachment: _attachment, rendered: _rendered, isMeta: _isMeta,
    toolUseResult: _toolUseResult, tool_use_result: _toolUseResultSnake, ...base } = row;
  const projected = RawJSONLinesSchema.safeParse({
    ...base, type: 'user',
    ...(observedSidechain ? { isSidechain: true, sidechainId: observedSidechain.sidechainId } : {}),
    origin: { ...nativeOrigin, kind: 'task-notification', taskId: notification.taskId,
      toolUseId, status: notification.status === 'complete' ? 'completed' : notification.status === 'cancelled' ? 'stopped' : 'failed', result },
    ...(notification.status === 'complete' || hasOwnContent ? {} : { toolUseResult: { status: notification.status, result } }),
    message: { role: 'user', content: [...ownContent, { type: 'tool_result', tool_use_id: toolUseId,
      content: hasOwnContent ? { status: notification.status, result }
        : report ? [{ type: 'text', text: report }] : existingResult?.content ?? [{ type: 'text', text: result }],
      is_error: notification.status !== 'complete' }] },
  });
  return projected.success ? projected.data : null;
}

/** Conversation correlation only; activity admission remains with the native lifecycle owner. */
export function createClaudeTaskNotificationToolResultProjector() {
  const tasks = new Map<string, { toolUseId?: string; sidechainId?: string; unroutedNotification?: unknown; report?: string; settled?: true }>();
  return {
    clear: () => tasks.clear(),
    project(value: unknown, observedSidechain?: Readonly<{ sidechainId: string }>): Readonly<{ message: RawJSONLines | null }> | null {
      const row = readRecord(value);
      const fact = readClaudeTaskLifecycleEnvelope(value);
      if (!row || !fact) return null;
      if ((row.isSidechain === true && !observedSidechain)
        || (observedSidechain && readString(row.sidechainId) && readString(row.sidechainId) !== observedSidechain.sidechainId)) {
        return fact.subtype === 'task_notification' ? { message: null } : null;
      }
      const task = fact.taskId ? tasks.get(fact.taskId) ?? {} : null;
      if (fact.subtype === 'agent-resume' && task) {
        delete task.unroutedNotification;
        delete task.report;
        delete task.settled;
        delete task.toolUseId;
        delete task.sidechainId;
        return null;
      }
      if ((fact.subtype === 'async-launch' || fact.subtype === 'task_started') && fact.taskId && fact.toolUseId && task) {
        // Native starts identify a new execution, including automatic wakes that
        // reuse the prior tool ID without a separate SendMessage response.
        if (fact.subtype === 'task_started' || task.toolUseId !== fact.toolUseId) {
          delete task.report;
          delete task.settled;
        }
        task.toolUseId = fact.toolUseId;
        task.sidechainId = observedSidechain?.sidechainId;
        tasks.set(fact.taskId, task);
        const pending = task.unroutedNotification;
        delete task.unroutedNotification;
        if (!pending) return null;
        const message = projectClaudeTaskLifecycleToolResult(pending, fact.toolUseId, observedSidechain, task.report);
        if (message) {
          task.settled = true;
          delete task.report;
        }
        return { message };
      }
      if (fact.subtype === 'handback') {
        const report = task?.toolUseId && !task.settled ? readClaudeNativePeerMessage(row)?.text : null;
        if (!task?.toolUseId || !report || (fact.toolUseId && fact.toolUseId !== task.toolUseId)) return null;
        // A report is not terminal evidence. The existing correlation retains it
        // until Claude supplies the actual success, failure or cancellation.
        task.report = report;
        return { message: null };
      }
      if (!isClaudeTaskLifecycleResultEnvelope(fact)) return null;
      const correlatedTask = task && (!fact.toolUseId || fact.toolUseId === task.toolUseId) ? task : null;
      if (correlatedTask?.settled && ['complete', 'failed', 'cancelled'].includes(fact.status)) {
        // Claude emits a system terminal edge and a queued XML representation
        // for the same invocation. Only the first settles its conversation tool.
        // A SendMessage response still owns its separate, visible tool result.
        return row.type === 'user' && fact.subtype === 'task_status' ? null : { message: null };
      }
      const scope = observedSidechain ?? (task?.sidechainId
        && (!fact.toolUseId || fact.toolUseId === task.toolUseId) ? { sidechainId: task.sidechainId } : undefined);
      const projected = projectClaudeTaskLifecycleToolResult(value, correlatedTask?.toolUseId, scope, correlatedTask?.report);
      if (!projected && fact.taskId && !fact.toolUseId && task && readString(row.uuid)
        && ['complete', 'failed', 'cancelled'].includes(fact.status)) {
        task.unroutedNotification = value;
        tasks.set(fact.taskId, task);
      }
      if (projected && fact.taskId && correlatedTask) {
        correlatedTask.settled = true;
        delete correlatedTask.report;
      }
      // A SendMessage response remains visible when its child's launch is not known.
      return projected || row.type !== 'user' || fact.subtype === 'task_notification' ? { message: projected } : null;
    },
  };
}
