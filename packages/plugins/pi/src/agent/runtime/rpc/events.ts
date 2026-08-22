import type {
  AgentSessionCompactRequest,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';

type WithoutSequence<T> = T extends { sequence: number } ? Omit<T, 'sequence'> : never;
export type PiRuntimeEvent = WithoutSequence<AgentSessionRuntimeEvent>;

type PiRuntimeEventProjectionContext = Readonly<{
  sessionId: string | null;
  turnId: string | null;
  agentSessionId: string | null;
  nowMs: () => number;
}>;

type ContextCompactionEvent = Extract<PiRuntimeEvent, { kind: 'context-compaction' }>;
type ContextCompactionTrigger = ContextCompactionEvent['trigger'];
type PiContextCompactionPayloadBase = Readonly<{
  compactionId: string;
  trigger: ContextCompactionTrigger;
}>;
export type PiContextCompactionPayload = PiContextCompactionPayloadBase & (
  | Readonly<{ phase: 'started'; tokenCountBefore?: number }>
  | Readonly<{ phase: 'completed'; tokenCountBefore?: number; tokenCountAfter?: number }>
  | Readonly<{ phase: 'cancelled' }>
  | Readonly<{
    phase: 'failed';
    diagnostic: Extract<ContextCompactionEvent, { phase: 'failed' }>['diagnostic'];
  }>
);

type PiContextCompactionPayloadOptions = Readonly<{
  compactionId?: string;
  trigger?: ContextCompactionTrigger;
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

function toJson(value: unknown) {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readSuccessfulCompactionResult(value: unknown): Readonly<Record<string, unknown>> | null {
  const result = isRecord(value) ? value : null;
  if (!result) return null;
  if (readRawString(result.summary) === null) return null;
  if (!readString(result.firstKeptEntryId)) return null;
  if (readNonNegativeNumber(result.tokensBefore) === null) return null;
  if (
    Object.prototype.hasOwnProperty.call(result, 'estimatedTokensAfter')
    && readNonNegativeNumber(result.estimatedTokensAfter) === null
  ) return null;
  return result;
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

function extractAssistantThinking(message: unknown): string | null {
  const record = isRecord(message) ? message : null;
  if (!record || record.role !== 'assistant' || !Array.isArray(record.content)) return null;
  let thinking = '';
  for (const item of record.content) {
    const entry = isRecord(item) ? item : null;
    if (!entry || entry.type !== 'thinking') continue;
    const chunk = readRawString(entry.thinking);
    if (chunk !== null) thinking += chunk;
  }
  return thinking.length > 0 ? thinking : null;
}

function projectMessageEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): PiRuntimeEvent[] {
  const base = turnEventBase(context);
  if (!base) return [];
  if (readString(record.type) !== 'message_update') return [];
  const assistantMessageEvent = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : null;
  const eventType = readString(assistantMessageEvent?.type);
  if (eventType !== 'text_delta' && eventType !== 'thinking_delta') return [];
  const text = readRawString(assistantMessageEvent?.delta);
  if (text === null || text.length === 0) return [];
  return [{
    ...base,
    kind: 'message-delta',
    channel: eventType === 'thinking_delta' ? 'reasoning' : 'assistant',
    text,
  }];
}

function projectToolStartEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): PiRuntimeEvent[] {
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
    input: toJson(isRecord(record.args) ? record.args : {}),
  }];
}

function projectToolEndEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): PiRuntimeEvent[] {
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
    output: toJson(record.result),
    ...(isError === null ? {} : { isError }),
  }];
}

function projectToolUpdateEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
): PiRuntimeEvent[] {
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

function readCompactionTrigger(value: unknown): ContextCompactionTrigger {
  const trigger = readString(value);
  if (trigger === 'manual' || trigger === 'threshold' || trigger === 'overflow') {
    return trigger;
  }
  return 'unknown';
}

function readCompactionPhase(record: Readonly<Record<string, unknown>>): 'started' | 'completed' | 'failed' | 'cancelled' {
  if (record.type === 'compaction_start') return 'started';
  if (record.aborted === true) return 'cancelled';
  return readSuccessfulCompactionResult(record.result) ? 'completed' : 'failed';
}

function readPiCompactionErrorPreview(value: unknown): string {
  const raw = readRawString(value)?.trim();
  if (!raw) return 'Pi compaction ended without a successful result.';
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const parsedRecord = isRecord(parsed) ? parsed : null;
      const nestedError = isRecord(parsedRecord?.error) ? parsedRecord.error : null;
      const message = readString(nestedError?.message) ?? readString(parsedRecord?.message);
      if (message) return redactBugReportSensitiveText(message).slice(0, 2_000);
    } catch {
      // Fall through to a stable non-provider-text diagnostic.
    }
  }
  return 'Pi compaction failed; provider details were redacted.';
}

export function buildPiContextCompactionPayload(
  record: unknown,
  options: PiContextCompactionPayloadOptions = {},
): PiContextCompactionPayload | null {
  if (!isRecord(record)) return null;
  const type = readString(record.type);
  if (type !== 'compaction_start' && type !== 'compaction_end') return null;
  const result = readSuccessfulCompactionResult(record.result) ?? {};
  const phase = readCompactionPhase(record);
  const tokenCountBefore = readNonNegativeNumber(result.tokensBefore);
  const tokenCountAfter = readNonNegativeNumber(result.estimatedTokensAfter);
  const common = {
    compactionId: options.compactionId ?? 'pi:context-compaction',
    trigger: options.trigger ?? readCompactionTrigger(record.reason),
  };
  if (phase === 'failed') {
    return {
      ...common,
      phase,
      diagnostic: {
        code: 'pi_compaction_failed',
        severity: 'error',
        message: readPiCompactionErrorPreview(record.errorMessage),
      },
    };
  }
  if (phase === 'cancelled') return { ...common, phase };
  if (phase === 'started') {
    return {
      ...common,
      phase,
      ...(tokenCountBefore === null ? {} : { tokenCountBefore }),
    };
  }
  return {
    ...common,
    phase,
    ...(tokenCountBefore === null ? {} : { tokenCountBefore }),
    ...(tokenCountAfter === null ? {} : { tokenCountAfter }),
  };
}

export function buildPiCompletedContextCompactionPayload(
  record: unknown,
  options: PiContextCompactionPayloadOptions = {},
): PiContextCompactionPayload | null {
  if (!isRecord(record) || readString(record.type) !== 'compaction_end') return null;
  return buildPiContextCompactionPayload(record, options);
}

function projectCompactionEvent(
  record: Readonly<Record<string, unknown>>,
  context: PiRuntimeEventProjectionContext,
  options: PiContextCompactionPayloadOptions = {},
): PiRuntimeEvent[] {
  const base = baseEvent(context);
  if (!base) return [];
  const payload = buildPiContextCompactionPayload(record, options);
  if (!payload) return [];
  const common = {
    ...base,
    kind: 'context-compaction',
    compactionId: payload.compactionId,
    trigger: payload.trigger,
    ...(context.turnId ? { turnId: context.turnId } : {}),
  } as const;
  if (payload.phase === 'failed') return [{ ...common, phase: payload.phase, diagnostic: payload.diagnostic }];
  if (payload.phase === 'cancelled') return [{ ...common, phase: payload.phase }];
  if (payload.phase === 'started') {
    return [{
      ...common,
      phase: payload.phase,
      ...(payload.tokenCountBefore === undefined ? {} : {
        tokenCountBefore: payload.tokenCountBefore,
        tokenCountSource: 'providerReported' as const,
      }),
    }];
  }
  return [{
    ...common,
    phase: payload.phase,
    ...(payload.tokenCountBefore === undefined ? {} : { tokenCountBefore: payload.tokenCountBefore }),
    ...(payload.tokenCountAfter === undefined ? {} : { tokenCountAfter: payload.tokenCountAfter }),
    ...((payload.tokenCountBefore !== undefined || payload.tokenCountAfter !== undefined)
      ? { tokenCountSource: 'providerReported' as const }
      : {}),
  }];
}

type ActivePiCompaction = {
  compactionId: string;
  trigger: ContextCompactionTrigger;
  terminal: boolean;
};

export function createPiRuntimeEventProjector(): Readonly<{
  project(record: unknown, context: PiRuntimeEventProjectionContext): PiRuntimeEvent[];
  expectHostCompaction(request: Pick<AgentSessionCompactRequest, 'compactionId' | 'trigger'>): void;
  clearExpectedHostCompaction(compactionId: string): void;
  resetTurn(): void;
}> {
  let compactionOrdinal = 0;
  let activeCompaction: ActivePiCompaction | null = null;
  let expectedHostCompaction: Pick<AgentSessionCompactRequest, 'compactionId' | 'trigger'> | null = null;
  let accumulatedThinkingText = '';

  return {
    project(record, context) {
      const raw = isRecord(record) ? record : null;
      const type = readString(raw?.type);
      if (raw && type === 'message_update') {
        const events = projectPiRuntimeEvents(record, context);
        for (const event of events) {
          if (event.kind === 'message-delta' && event.channel === 'reasoning') {
            accumulatedThinkingText += event.text;
          }
        }
        return events;
      }
      if (raw && type === 'message_end') {
        const fullText = extractAssistantThinking(raw.message);
        const streamedText = accumulatedThinkingText;
        accumulatedThinkingText = '';
        if (!fullText) return [];
        const text = streamedText.length === 0
          ? fullText
          : fullText.startsWith(streamedText)
            ? fullText.slice(streamedText.length)
            : `\n\n${fullText}`;
        const base = turnEventBase(context);
        if (!base || text.length === 0) return [];
        return [{
          ...base,
          kind: 'message-delta',
          channel: 'reasoning',
          text,
        }];
      }
      if (!raw || (type !== 'compaction_start' && type !== 'compaction_end')) {
        return projectPiRuntimeEvents(record, context);
      }

      const trigger = readCompactionTrigger(raw.reason);
      if (type === 'compaction_start') {
        if (activeCompaction && !activeCompaction.terminal) return [];
        compactionOrdinal += 1;
        activeCompaction = {
          compactionId: expectedHostCompaction?.compactionId
            ?? `pi:${context.agentSessionId ?? 'session'}:${context.turnId ?? 'turn'}:compaction:${compactionOrdinal}`,
          trigger: expectedHostCompaction?.trigger ?? trigger,
          terminal: false,
        };
        expectedHostCompaction = null;
        return projectCompactionEvent(raw, context, activeCompaction);
      }

      if (!activeCompaction || activeCompaction.terminal || activeCompaction.trigger !== trigger) return [];
      const events = projectCompactionEvent(raw, context, activeCompaction);
      activeCompaction.terminal = true;
      return events;
    },
    expectHostCompaction(request) {
      expectedHostCompaction = request;
    },
    clearExpectedHostCompaction(compactionId) {
      if (expectedHostCompaction?.compactionId === compactionId) expectedHostCompaction = null;
    },
    resetTurn() {
      compactionOrdinal = 0;
      activeCompaction = null;
      expectedHostCompaction = null;
      accumulatedThinkingText = '';
    },
  };
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
): PiRuntimeEvent[] {
  const raw = isRecord(record) ? record : null;
  if (!raw) return [];
  const type = readString(raw.type);
  if (type === 'message_update') return projectMessageEvent(raw, context);
  if (type === 'tool_execution_start') return projectToolStartEvent(raw, context);
  if (type === 'tool_execution_end') return projectToolEndEvent(raw, context);
  if (type === 'tool_execution_update') return projectToolUpdateEvent(raw, context);
  return [];
}
