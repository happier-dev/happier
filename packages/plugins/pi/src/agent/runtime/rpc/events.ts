import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

type PiRuntimeEventProjectionContext = Readonly<{
  sessionId: string | null;
  turnId: string | null;
  agentSessionId: string | null;
  nowMs: () => number;
}>;

type ContextCompactionEventV1 = Extract<RuntimeEventV1, { kind: 'context-compaction' }>;
type ContextCompactionTriggerV1 = NonNullable<ContextCompactionEventV1['trigger']>;
export type PiContextCompactionAcpPayload = Readonly<{
  type: 'context-compaction';
  phase: ContextCompactionEventV1['phase'];
  lifecycleId: string;
  source: ContextCompactionEventV1['source'];
  trigger: ContextCompactionTriggerV1;
  backendId: string;
  agentId: string;
  agentEventId?: string;
  agentSessionId?: string;
  turnId?: string;
  tokenCountBefore?: number;
  tokenCountAfter?: number;
  retryAttempt?: number;
  errorCode?: string;
  sanitizedErrorPreview?: string;
}>;

type PiContextCompactionPayloadOptions = Readonly<{
  allowAutoTrigger?: boolean;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRawString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return value === true || value === false ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readTruncatedNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function baseEvent(context: PiRuntimeEventProjectionContext) {
  const sessionId = context.sessionId;
  if (!sessionId) return null;
  return {
    sessionId,
    emittedAtMs: context.nowMs(),
  };
}

function turnEventBase(context: PiRuntimeEventProjectionContext) {
  const base = baseEvent(context);
  if (!base || !context.turnId) return null;
  return {
    ...base,
    turnId: context.turnId,
  };
}

function extractAssistantText(message: unknown): string | null {
  const record = isRecord(message) ? message : null;
  if (!record || record.role !== 'assistant' || !Array.isArray(record.content)) return null;
  let text = '';
  for (const item of record.content) {
    const entry = isRecord(item) ? item : null;
    if (!entry || entry.type !== 'text') continue;
    const chunk = readRawString(entry.text);
    if (chunk === null) continue;
    text += chunk;
  }
  return text.length > 0 ? text : null;
}

function extractToolText(value: unknown): string | null {
  const record = isRecord(value) ? value : null;
  if (!record || !Array.isArray(record.content)) return null;
  let text = '';
  for (const item of record.content) {
    const entry = isRecord(item) ? item : null;
    if (!entry || entry.type !== 'text') continue;
    const chunk = readRawString(entry.text);
    if (chunk === null) continue;
    text += chunk;
  }
  return text.length > 0 ? text : null;
}

function projectMessageEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): RuntimeEventV1[] {
  const base = turnEventBase(context);
  if (!base) return [];
  const type = readString(record.type);
  if (type === 'message_update') {
    const assistantMessageEvent = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : null;
    const assistantEventType = readString(assistantMessageEvent?.type);
    if (
      assistantEventType !== 'text_start'
      && assistantEventType !== 'text_delta'
      && assistantEventType !== 'text_end'
    ) {
      return [];
    }
  }
  const text = extractAssistantText(record.message);
  if (text === null) return [];
  return [{
    ...base,
    kind: 'message-delta',
    delta: { text },
  }];
}

function projectToolStartEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): RuntimeEventV1[] {
  const base = turnEventBase(context);
  if (!base) return [];
  const toolCallId = readString(record.toolCallId);
  const toolName = readString(record.toolName);
  if (!toolCallId || !toolName) return [];
  return [{
    ...base,
    kind: 'tool-call',
    toolCallId,
    toolName,
    toolInput: isRecord(record.args) ? record.args : {},
  }];
}

function projectToolEndEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): RuntimeEventV1[] {
  const base = turnEventBase(context);
  if (!base) return [];
  const toolCallId = readString(record.toolCallId);
  const toolName = readString(record.toolName);
  if (!toolCallId || !toolName) return [];
  const isError = readBoolean(record.isError);
  return [{
    ...base,
    kind: 'tool-result',
    toolCallId,
    output: record.result,
    ...(isError === null ? {} : { isError }),
  }];
}

function projectToolUpdateEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): RuntimeEventV1[] {
  const base = turnEventBase(context);
  if (!base) return [];
  const toolCallId = readString(record.toolCallId);
  if (!toolCallId) return [];
  const chunk = extractToolText(record.partialResult);
  if (chunk === null) return [];
  return [{
    ...base,
    kind: 'tool-progress',
    toolCallId,
    progress: { _stream: true, stdoutChunk: chunk },
  }];
}

function readCompactionTrigger(
  value: unknown,
  options: PiContextCompactionPayloadOptions = {},
): ContextCompactionTriggerV1 {
  const trigger = readString(value);
  if (
    trigger === 'manual'
    || trigger === 'threshold'
    || trigger === 'overflow'
    || trigger === 'unknown'
  ) {
    return trigger;
  }
  if (trigger === 'auto' && options.allowAutoTrigger === true) return trigger;
  return 'unknown';
}

function readCompactionPhase(record: Readonly<Record<string, unknown>>): 'started' | 'completed' | 'failed' | 'cancelled' {
  if (record.type === 'compaction_start') return 'started';
  const result = isRecord(record.result) ? record.result : {};
  const terminalPhase = readString(record.phase ?? result.phase ?? record.status ?? result.status);
  if (terminalPhase === 'cancelled' || terminalPhase === 'canceled') return 'cancelled';
  if (terminalPhase === 'failed') return 'failed';
  if (
    record.cancelled === true
    || record.canceled === true
    || result.cancelled === true
    || result.canceled === true
  ) return 'cancelled';
  if (
    record.aborted === true
    || readString(record.errorCode ?? result.errorCode)
    || readString(record.errorMessage)
    || readString(record.sanitizedErrorPreview ?? result.sanitizedErrorPreview)
  ) return 'failed';
  return 'completed';
}

function readCompactionLifecycleId(record: Readonly<Record<string, unknown>>): string {
  const result = isRecord(record.result) ? record.result : {};
  return readString(record.lifecycleId)
    ?? readString(record.compactionId)
    ?? readString(record.compaction_id)
    ?? readString(result.lifecycleId)
    ?? readString(result.compactionId)
    ?? readString(result.compaction_id)
    ?? readString(record.id)
    ?? readString(record.turnId)
    ?? readString(record.turn_id)
    ?? 'pi:context-compaction';
}

export function buildPiContextCompactionPayload(
  record: unknown,
  options: PiContextCompactionPayloadOptions = {},
): PiContextCompactionAcpPayload | null {
  if (!isRecord(record)) return null;
  const type = readString(record.type);
  if (type !== 'compaction_start' && type !== 'compaction_end') return null;
  const result = isRecord(record.result) ? record.result : {};
  const agentEventId = readString(record.id);
  const tokenCountBefore = readNonNegativeNumber(result.tokensBefore ?? result.tokenCountBefore ?? record.tokensBefore);
  const tokenCountAfter = readNonNegativeNumber(result.tokensAfter ?? result.tokenCountAfter ?? record.tokensAfter);
  const retryAttempt = readTruncatedNonNegativeInteger(
    result.retryAttempt
      ?? result.retry_attempt
      ?? record.retryAttempt
      ?? record.retry_attempt,
  );
  const errorCode = readString(record.errorCode ?? result.errorCode);
  const sanitizedErrorPreview = readString(record.sanitizedErrorPreview ?? result.sanitizedErrorPreview);
  return {
    type: 'context-compaction',
    phase: readCompactionPhase(record),
    lifecycleId: readCompactionLifecycleId(record),
    source: 'agent-event',
    trigger: readCompactionTrigger(record.reason, options),
    backendId: 'pi',
    agentId: 'pi',
    ...(agentEventId ? { agentEventId } : {}),
    ...(tokenCountBefore === null ? {} : { tokenCountBefore }),
    ...(tokenCountAfter === null ? {} : { tokenCountAfter }),
    ...(retryAttempt === null ? {} : { retryAttempt }),
    ...(errorCode ? { errorCode } : {}),
    ...(sanitizedErrorPreview ? { sanitizedErrorPreview } : {}),
  };
}

export function buildPiCompletedContextCompactionPayload(
  record: unknown,
  options: PiContextCompactionPayloadOptions = {},
): PiContextCompactionAcpPayload | null {
  if (!isRecord(record) || readString(record.type) !== 'compaction_end') return null;
  return buildPiContextCompactionPayload(record, options);
}

function projectCompactionEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): RuntimeEventV1[] {
  const base = baseEvent(context);
  if (!base) return [];
  const payload = buildPiContextCompactionPayload(record, { allowAutoTrigger: true });
  if (!payload) return [];
  return [{
    ...base,
    kind: 'context-compaction',
    phase: payload.phase,
    lifecycleId: payload.lifecycleId,
    source: payload.source,
    trigger: payload.trigger,
    backendId: payload.backendId,
    agentId: payload.agentId,
    ...(payload.agentEventId ? { agentEventId: payload.agentEventId } : {}),
    ...(payload.tokenCountBefore === undefined ? {} : { tokenCountBefore: payload.tokenCountBefore }),
    ...(payload.tokenCountAfter === undefined ? {} : { tokenCountAfter: payload.tokenCountAfter }),
    ...(payload.retryAttempt === undefined ? {} : { retryAttempt: payload.retryAttempt }),
    ...(payload.errorCode ? { errorCode: payload.errorCode } : {}),
    ...(payload.sanitizedErrorPreview ? { sanitizedErrorPreview: payload.sanitizedErrorPreview } : {}),
    ...(context.agentSessionId ? { agentSessionId: context.agentSessionId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  }];
}

export function readPiProviderTurnId(record: unknown): string | null {
  const raw = isRecord(record) ? record : null;
  if (!raw) return null;
  return readString(raw.turnId ?? raw.id);
}

export function readPiRuntimeRecordType(record: unknown): string | null {
  const raw = isRecord(record) ? record : null;
  return raw ? readString(raw.type) : null;
}

export function projectPiRuntimeEvents(
  record: unknown,
  context: PiRuntimeEventProjectionContext,
): RuntimeEventV1[] {
  const raw = isRecord(record) ? record : null;
  if (!raw) return [];
  const type = readString(raw.type);
  if (type === 'message_update' || type === 'message_end') return projectMessageEvent(raw, context);
  if (type === 'tool_execution_start') return projectToolStartEvent(raw, context);
  if (type === 'tool_execution_end') return projectToolEndEvent(raw, context);
  if (type === 'tool_execution_update') return projectToolUpdateEvent(raw, context);
  if (type === 'compaction_start' || type === 'compaction_end') return projectCompactionEvent(raw, context);
  return [];
}
