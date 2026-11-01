import { isClaudeAsyncAgentLaunchToolResult, isGenericSubAgentToolName, normalizeClaudeActivityStatusSignal, readClaudePeerMessage, type ClaudeActivityStatusSignal } from '@happier-dev/protocol';

import { parseClaudeTaskNotificationXml } from './claudeTaskNotificationXml';
import { RawJSONLinesSchema, type RawJSONLines } from '../types';
import { embedClaudeToolResultMetadata } from '../utils/claudeToolResultMetadata';

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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Native transcript envelopes share one identity/status reader across runtime and history. */
export function readClaudeTaskLifecycleEnvelope(value: unknown): ClaudeTaskLifecycleEnvelope | null {
  const row = record(value);
  if (!row) return null;
  // Native queue-operation records omit origin/mode and also log ordinary queued prompts.
  if (row.type === 'queue-operation') return null;
  const attachment = row.type === 'attachment' ? record(row.attachment) : null;
  const origin = record(row.origin) ?? (attachment?.type === 'queued_command' ? record(attachment.origin) : null);
  const sourceSessionId = text(row.session_id ?? row.sessionId) ?? undefined;
  const uuid = text(row.uuid) ?? undefined;
  const identity = {
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(uuid ? { uuid } : {}),
  };
  const hookName = text(row.hook_event_name ?? row.hookEventName ?? row.eventName);
  if (row.type === 'system' && row.subtype === 'task_started') {
    const taskId = text(row.task_id);
    return taskId ? { subtype: 'task_started', taskId, toolUseId: text(row.tool_use_id), status: 'active', ...identity } : null;
  }
  if (row.type === 'system' && row.subtype === 'task_notification') {
    const taskId = text(row.task_id);
    if (!taskId) return null;
    const summary = text(row.summary);
    return { subtype: 'task_notification', taskId, toolUseId: text(row.tool_use_id),
      status: normalizeClaudeActivityStatusSignal(row.status, 'task_notification'),
      ...(summary ? { summary } : {}), ...identity };
  }
  if (hookName === 'SubagentStart') {
    const taskId = text(row.agent_id ?? row.agentId);
    return taskId ? { subtype: 'agent-resume', taskId, toolUseId: null, status: 'active',
      resumed: true, knownOnly: true, ...identity } : null;
  }
  const response = row.type === 'user' ? record(row.toolUseResult ?? row.tool_use_result) : null;
  const hookResponse = hookName === 'PostToolUse' ? record(row.tool_response ?? row.toolResponse ?? row.toolUseResult ?? row.tool_use_result) : null;
  const toolName = text(row.tool_name ?? row.toolName);
  const resumeResponse = hookName === 'PostToolUse' && toolName === 'SendMessage' ? hookResponse : response;
  // Claude 2.1.296 explicitly reports a user-stopped child in a failed SendMessage
  // response, without a later task notification. Read native response metadata only;
  // ordinary text or an arbitrary failed delivery cannot prove cancellation.
  const stoppedTaskId = resumeResponse?.success === false
    ? /^Agent (\S+) was stopped by the user and won't be resumed\./.exec(text(resumeResponse.message) ?? '')?.[1]
    : undefined;
  const nativeResultContent = record(row.message)?.content;
  const hasNativeToolResult = Array.isArray(nativeResultContent)
    && nativeResultContent.some(block => record(block)?.type === 'tool_result' && text(record(block)?.tool_use_id));
  const stoppedTargetMatches = hookName === 'PostToolUse'
    ? toolName === 'SendMessage' && text(record(row.tool_input ?? row.toolInput)?.to) === stoppedTaskId
    : row.type === 'user' && hasNativeToolResult;
  if (stoppedTaskId && stoppedTargetMatches) {
    return { subtype: 'task_status', taskId: stoppedTaskId, toolUseId: null,
      status: 'cancelled', summary: text(resumeResponse?.message) ?? undefined, ...identity };
  }
  const resumedAgentId = text(resumeResponse?.resumedAgentId ?? resumeResponse?.resumed_agent_id);
  if (resumedAgentId && resumeResponse && resumeResponse.success !== false && resumeResponse.is_error !== true
    && resumeResponse.isError !== true && resumeResponse.error == null
    && !['failed', 'error', 'denied', 'rejected'].includes(text(resumeResponse.status)?.toLowerCase() ?? '')) {
    // Claude returns this field only for detached asynchronous resumes, even for a formerly foreground child.
    return { subtype: 'agent-resume', taskId: resumedAgentId, toolUseId: null, status: 'active', resumed: true, ...identity };
  }
  const asyncResponse = hookResponse && toolName && (isGenericSubAgentToolName(toolName) || toolName === 'Workflow')
    ? hookResponse : response;
  if (isClaudeAsyncAgentLaunchToolResult(asyncResponse)) {
    const taskId = text(asyncResponse?.agentId ?? asyncResponse?.agent_id ?? asyncResponse?.taskId ?? asyncResponse?.task_id);
    const content = record(row.message)?.content;
    const result = Array.isArray(content) ? content.map(record).find(block => block?.type === 'tool_result') : null;
    if (result?.is_error === true || asyncResponse?.success === false || asyncResponse?.is_error === true
      || asyncResponse?.isError === true || asyncResponse?.error != null) return null;
    const toolUseId = text(row.tool_use_id ?? row.toolUseId) ?? text(result?.tool_use_id);
    return { subtype: 'async-launch', taskId, toolUseId, status: 'active', ...identity };
  }
  if (attachment?.type === 'task_status') {
    const taskId = text(attachment.taskId ?? attachment.task_id);
    if (!taskId) return null;
    const taskType = text(attachment.taskType ?? attachment.task_type);
    return {
      subtype: 'task_status',
      taskId,
      toolUseId: text(attachment.toolUseId ?? attachment.tool_use_id) ?? text(record(attachment.shell)?.toolUseId),
      status: normalizeClaudeActivityStatusSignal(attachment.status),
      ...(taskType ? { taskType } : {}),
      ...identity,
    };
  }
  if ((row.type === 'user' || attachment?.type === 'queued_command') && origin?.kind === 'peer' && origin.handback === true) {
    const taskId = text(origin.senderTaskId) ?? text(origin.from);
    // SubagentHandback delivers a report before execution necessarily settles (Claude 2.1.291).
    return taskId ? { subtype: 'handback', taskId, toolUseId: null, status: 'active', ...identity } : null;
  }
  // Lifecycle decisions require native delivery provenance; presentation can still inspect copied XML.
  const nativeNotification = origin?.kind === 'task-notification'
    || (attachment?.type === 'queued_command' && attachment.commandMode === 'task-notification');
  if (!nativeNotification) return null;
  const xml = parseClaudeTaskNotificationXml(value);
  const notificationOrigin = origin?.kind === 'task-notification' ? origin : null;
  if (!xml && !notificationOrigin) return null;
  const summary = text(notificationOrigin?.summary) ?? xml?.summary;
  const result = text(notificationOrigin?.result) ?? xml?.result;
  return {
    subtype: 'task_notification',
    taskId: text(notificationOrigin?.taskId ?? notificationOrigin?.task_id) ?? xml?.taskId ?? null,
    toolUseId: text(notificationOrigin?.toolUseId ?? notificationOrigin?.tool_use_id) ?? xml?.toolUseId ?? null,
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
  sidechain?: Readonly<{ sidechainId: string; agentId?: string }>, report?: string): RawJSONLines | null {
  const row = record(value);
  const notification = readClaudeTaskLifecycleEnvelope(value);
  if (!row || (row.isSidechain === true && !sidechain) || !isClaudeTaskLifecycleResultEnvelope(notification)
    || !['complete', 'failed', 'cancelled'].includes(notification.status)) return null;
  if (sidechain && ((text(row.sidechainId) && text(row.sidechainId) !== sidechain.sidechainId)
    || (sidechain.agentId && text(row.agentId) && text(row.agentId) !== sidechain.agentId))) return null;
  const toolUseId = notification.toolUseId ?? correlatedToolUseId;
  if (!toolUseId || !text(row.uuid)) return null;
  const result = report ?? notification.result ?? notification.summary ?? notification.status;
  // Released scanner rows already contain the findings, but do not carry origin.result.
  // Preserve only the result for this authenticated tool identity when reprojecting it.
  const content = record(row.message)?.content;
  const existingResult = Array.isArray(content) ? content.map(record).find(block =>
    block?.type === 'tool_result' && text(block.tool_use_id) === toolUseId) : null;
  const ownContent = Array.isArray(content) ? content.filter(block => {
    const result = record(block);
    return result?.type !== 'tool_result' || text(result.tool_use_id) !== toolUseId;
  }) : [];
  // A failed SendMessage response can also prove its target child was stopped.
  // Its own result must survive alongside the child's outcome, with metadata scoped per block.
  const preservedContent = embedClaudeToolResultMetadata(ownContent, row.toolUseResult ?? row.tool_use_result);
  const hasOwnContent = ownContent.length > 0;
  const nativeOrigin = record(row.origin) ?? record(record(row.attachment)?.origin);
  const { attachment: _attachment, rendered: _rendered, isMeta: _isMeta,
    toolUseResult: _toolUseResult, tool_use_result: _toolUseResultSnake, ...base } = row;
  const projected = RawJSONLinesSchema.safeParse({
    ...base,
    type: 'user',
    ...(sidechain ? { isSidechain: true, sidechainId: sidechain.sidechainId } : {}),
    origin: { ...nativeOrigin, kind: 'task-notification', taskId: notification.taskId,
      toolUseId, status: notification.status === 'complete' ? 'completed' : notification.status === 'cancelled' ? 'stopped' : 'failed', result },
    ...(notification.status === 'complete' || hasOwnContent ? {} : { toolUseResult: { status: notification.status, result } }),
    message: { role: 'user', content: [
      ...(Array.isArray(preservedContent) ? preservedContent : []),
      { type: 'tool_result', tool_use_id: toolUseId,
        content: hasOwnContent ? { status: notification.status, result }
          : report ? [{ type: 'text', text: report }] : existingResult?.content ?? [{ type: 'text', text: result }],
        is_error: notification.status !== 'complete' },
    ] },
  });
  return projected.success ? projected.data : null;
}

/** Conversation correlation only; activity admission remains with the native lifecycle owner. */
export function createClaudeTaskNotificationToolResultProjector(sidechain?: Readonly<{ sidechainId: string; agentId: string }>) {
  const tasks = new Map<string, { toolUseId?: string; sidechainId?: string; unroutedNotification?: unknown; report?: string }>();
  return {
    clear: () => tasks.clear(),
    project(value: unknown, observedSidechain?: Readonly<{ sidechainId: string }>): Readonly<{ message: RawJSONLines | null }> | null {
      const row = record(value);
      const fact = readClaudeTaskLifecycleEnvelope(value);
      if (!row || (row.isSidechain === true && !sidechain && !observedSidechain) || !fact) return null;
      if (sidechain && ((text(row.sidechainId) && text(row.sidechainId) !== sidechain.sidechainId)
        || (text(row.agentId) && text(row.agentId) !== sidechain.agentId))) return null;
      const task = fact.taskId ? tasks.get(fact.taskId) ?? {} : null;
      if (fact.subtype === 'agent-resume' && task) {
        delete task.unroutedNotification;
        delete task.report;
        delete task.toolUseId;
        delete task.sidechainId;
        return null;
      }
      if ((fact.subtype === 'async-launch' || fact.subtype === 'task_started') && fact.taskId && fact.toolUseId && task) {
        task.toolUseId = fact.toolUseId;
        task.sidechainId = sidechain?.sidechainId ?? observedSidechain?.sidechainId;
        tasks.set(fact.taskId, task);
        const pending = task.unroutedNotification;
        delete task.unroutedNotification;
        if (!pending) return null;
        const message = projectClaudeTaskLifecycleToolResult(pending, fact.toolUseId, sidechain ?? observedSidechain, task.report);
        if (message) tasks.delete(fact.taskId);
        return { message };
      }
      if (fact.subtype === 'handback') {
        const report = readClaudePeerMessage(row)?.text;
        if (!task?.toolUseId || !report || (fact.toolUseId && fact.toolUseId !== task.toolUseId)) return null;
        // A report is not a terminal fact. Retain it on the existing task correlation
        // until the native notification supplies the actual success/failure/cancellation.
        task.report = report;
        return { message: null };
      }
      if (!isClaudeTaskLifecycleResultEnvelope(fact)) return null;
      const correlatedTask = task && (!fact.toolUseId || fact.toolUseId === task.toolUseId) ? task : null;
      const scope = sidechain ?? observedSidechain ?? (task?.sidechainId
        && (!fact.toolUseId || fact.toolUseId === task.toolUseId) ? { sidechainId: task.sidechainId } : undefined);
      const projected = projectClaudeTaskLifecycleToolResult(value, correlatedTask?.toolUseId, scope, correlatedTask?.report);
      if (!projected && fact.taskId && !fact.toolUseId && task && text(row.uuid)
        && ['complete', 'failed', 'cancelled'].includes(fact.status)) {
        // A detached child can settle before the parent finishes PostToolUse and writes its ACK.
        task.unroutedNotification = value;
        tasks.set(fact.taskId, task);
      }
      if (projected && fact.taskId && correlatedTask) tasks.delete(fact.taskId);
      // A native SendMessage result remains visible even before its child's launch is known.
      return projected || row.type !== 'user' || fact.subtype === 'task_notification' ? { message: projected } : null;
    },
  };
}
