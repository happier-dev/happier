import {
  mapAntigravityStepsToRuntimeEvents,
  normalizeAntigravityToolName,
  type AntigravityStep,
} from '../../normalize/index.js';
import type {
  AgentExternalSessionLinkDataValue,
  AgentExternalSessionTranscriptItem,
} from '@happier-dev/plugin-sdk/experimental/sessions';

type JsonRecord = Readonly<Record<string, unknown>>;

type TranscriptMappingOptions = Readonly<{
  generatedIdNamespace?: string;
}>;

type TranscriptMappingContext = Readonly<{
  pendingToolCallIds: string[];
  nextFallbackToolCallId: () => string;
  generatedIdNamespace?: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readId(record: JsonRecord): string | undefined {
  return readString(record.id) ?? readString(record.stepId) ?? readString(record.step_id) ?? undefined;
}

function readStepIndex(record: JsonRecord): string | undefined {
  if (typeof record.step_index === 'number' && Number.isFinite(record.step_index)) {
    return String(record.step_index);
  }
  if (typeof record.stepIndex === 'number' && Number.isFinite(record.stepIndex)) {
    return String(record.stepIndex);
  }
  return readString(record.step_index) ?? readString(record.stepIndex) ?? undefined;
}

function buildGeneratedStepIdentity(
  stepIndex: string | undefined,
  context?: Pick<TranscriptMappingContext, 'generatedIdNamespace'>,
): string | undefined {
  if (!stepIndex) return undefined;
  const namespace = context?.generatedIdNamespace?.trim();
  return namespace
    ? `antigravity-turn-${namespace}-step-${stepIndex}`
    : `antigravity-step-${stepIndex}`;
}

function readStepIdentity(
  record: JsonRecord,
  context?: Pick<TranscriptMappingContext, 'generatedIdNamespace'>,
): string | undefined {
  return readId(record) ?? buildGeneratedStepIdentity(readStepIndex(record), context);
}

function readText(record: JsonRecord): string | null {
  const direct = readString(record.text) ?? readString(record.message) ?? readString(record.content);
  if (direct) return direct;
  const message = record.message;
  if (isRecord(message)) return readString(message.text) ?? readString(message.content);
  return null;
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readToolCalls(record: JsonRecord): readonly JsonRecord[] {
  return readArray(record.tool_calls ?? record.toolCalls)
    .filter((entry): entry is JsonRecord => isRecord(entry));
}

function readToolCallId(record: JsonRecord): string | undefined {
  return readString(record.toolCallId)
    ?? readString(record.tool_call_id)
    ?? readString(record.callId)
    ?? readString(record.id)
    ?? undefined;
}

function readToolCallName(record: JsonRecord): string | null {
  return readString(record.name)
    ?? readString(record.toolName)
    ?? readString(record.tool_name)
    ?? readString(record.functionName);
}

function readToolCallInput(record: JsonRecord): unknown {
  return record.args ?? record.arguments ?? record.input ?? record.parameters ?? {};
}

function mapPlannerToolCalls(
  record: JsonRecord,
  context?: TranscriptMappingContext,
): AntigravityStep[] {
  const parentIdentity = readStepIdentity(record, context);
  return readToolCalls(record).flatMap((toolCall, index) => {
    const toolName = readToolCallName(toolCall);
    if (!toolName) return [];
    const id = readToolCallId(toolCall)
      ?? (parentIdentity ? `${parentIdentity}-tool-${index + 1}` : undefined)
      ?? context?.nextFallbackToolCallId();
    if (id) context?.pendingToolCallIds.push(id);
    const input = readToolCallInput(toolCall);
    return [{
      ...(id ? { id } : {}),
      kind: 'tool_call' as const,
      toolName: normalizeAntigravityToolName({ sourceName: toolName, input }),
      input,
    }];
  });
}

function readToolResultOutput(record: JsonRecord): unknown {
  return record.output ?? record.result ?? record.content ?? record.text ?? '';
}

function mapTypedToolResult(
  record: JsonRecord,
  context?: TranscriptMappingContext,
): AntigravityStep {
  const id = readStepIdentity(record, context);
  const toolCallId = readToolCallId(record)
    ?? context?.pendingToolCallIds.shift()
    ?? id
    ?? context?.nextFallbackToolCallId()
    ?? 'antigravity-unmatched-tool-result';
  return {
    ...(id ? { id } : {}),
    kind: 'tool_result',
    toolCallId,
    output: readToolResultOutput(record),
    ...(typeof record.isError === 'boolean' ? { isError: record.isError } : {}),
  };
}

function mapAntigravityTranscriptRecordToStepsWithContext(
  record: JsonRecord,
  context?: TranscriptMappingContext,
): readonly AntigravityStep[] {
  const type = (readString(record.type) ?? readString(record.eventType))?.toLowerCase();
  const id = readStepIdentity(record, context);
  if (!type) return [];
  if (['user_input', 'user', 'user_message'].includes(type)) {
    const text = readText(record);
    return text ? [{ ...(id ? { id } : {}), kind: 'user_message', text }] : [];
  }
  if (['planner_response', 'assistant', 'assistant_message', 'conversation_history'].includes(type)) {
    const text = readText(record);
    return [
      ...(text ? [{ ...(id ? { id } : {}), kind: 'assistant_message' as const, text }] : []),
      ...mapPlannerToolCalls(record, context),
    ];
  }
  if (['run_command', 'code_action', 'list_directory', 'view_file', 'file_action'].includes(type)) {
    return [mapTypedToolResult(record, context)];
  }
  if (['tool_result', 'command_result', 'action_result'].includes(type)) {
    return [mapTypedToolResult(record, context)];
  }
  if (type === 'checkpoint') {
    return [{
      ...(id ? { id } : {}),
      kind: 'checkpoint',
      ...(readString(record.checkpointId) ? { checkpointId: readString(record.checkpointId) ?? undefined } : {}),
    }];
  }
  if (['system_message', 'system'].includes(type)) {
    const text = readText(record);
    return text ? [{ ...(id ? { id } : {}), kind: 'system_message', text }] : [];
  }
  if (type === 'error') {
    const message = readString(record.message) ?? readString(record.error) ?? 'Antigravity CLI transcript error.';
    return [{ ...(id ? { id } : {}), kind: 'error', message }];
  }
  return [];
}

export function mapAntigravityTranscriptRecordToSteps(
  record: JsonRecord,
  options: TranscriptMappingOptions = {},
): readonly AntigravityStep[] {
  return mapAntigravityTranscriptRecordToStepsWithContext(record, {
    pendingToolCallIds: [],
    nextFallbackToolCallId: () => options.generatedIdNamespace?.trim()
      ? `antigravity-turn-${options.generatedIdNamespace.trim()}-tool-1`
      : 'antigravity-tool-1',
    ...(options.generatedIdNamespace?.trim() ? { generatedIdNamespace: options.generatedIdNamespace.trim() } : {}),
  });
}

export function mapAntigravityTranscriptRecordsToSteps(
  records: readonly JsonRecord[],
  options: TranscriptMappingOptions = {},
): readonly AntigravityStep[] {
  let fallbackToolCallId = 0;
  const generatedIdNamespace = options.generatedIdNamespace?.trim();
  const context = {
    pendingToolCallIds: [] as string[],
    nextFallbackToolCallId: () => generatedIdNamespace
      ? `antigravity-turn-${generatedIdNamespace}-tool-${fallbackToolCallId += 1}`
      : `antigravity-tool-${fallbackToolCallId += 1}`,
    ...(generatedIdNamespace ? { generatedIdNamespace } : {}),
  };
  return records.flatMap((record) => mapAntigravityTranscriptRecordToStepsWithContext(record, context));
}

export function mapAntigravityTranscriptRecordToStep(record: JsonRecord): AntigravityStep | null {
  return mapAntigravityTranscriptRecordToSteps(record)[0] ?? null;
}

export function mapAntigravityTranscriptStepsToRuntimeEvents(params: Readonly<{
  sessionId: string;
  turnId: string;
  emittedAtMs: number;
  steps: readonly AntigravityStep[];
}>): ReturnType<typeof mapAntigravityStepsToRuntimeEvents> {
  return mapAntigravityStepsToRuntimeEvents(params);
}

export type AntigravityTranscriptRecordWithOffsets = Readonly<{
  record: JsonRecord;
  startOffsetBytes: number;
  endOffsetBytes: number;
}>;

export type AntigravityExternalTranscriptItemGroup = Readonly<{
  startOffsetBytes: number;
  endOffsetBytes: number;
  items: readonly AgentExternalSessionTranscriptItem[];
}>;

function readCreatedAtMs(record: JsonRecord): number {
  const value = record.created_at ?? record.createdAt ?? record.timestamp ?? record.time;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function toLinkDataValue(value: unknown): AgentExternalSessionLinkDataValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toLinkDataValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toLinkDataValue(entry)]),
    );
  }
  return null;
}

function projectStep(params: Readonly<{
  step: AntigravityStep;
  fallbackId: string;
  createdAtMs: number;
}>): AgentExternalSessionTranscriptItem {
  const id = params.step.id ?? params.fallbackId;
  const localId = params.step.id;
  const common = {
    id,
    createdAtMs: params.createdAtMs,
    ...(localId ? { localId } : {}),
  };
  switch (params.step.kind) {
    case 'user_message':
      return { ...common, messageRole: 'user', raw: { type: 'text', text: params.step.text } };
    case 'assistant_message':
      return { ...common, messageRole: 'agent', raw: { type: 'text', text: params.step.text } };
    case 'tool_call':
      return {
        ...common,
        messageRole: 'event',
        raw: {
          type: 'tool-call',
          callId: id,
          name: params.step.toolName,
          input: toLinkDataValue(params.step.input),
          id,
        },
      };
    case 'tool_result':
      return {
        ...common,
        messageRole: 'event',
        raw: {
          type: 'tool-result',
          callId: params.step.toolCallId,
          output: toLinkDataValue(params.step.output),
          id,
          ...(params.step.isError !== undefined ? { isError: params.step.isError } : {}),
        },
      };
    case 'checkpoint':
      return {
        ...common,
        messageRole: 'event',
        raw: {
          type: 'antigravity_checkpoint',
          ...(params.step.checkpointId ? { checkpointId: params.step.checkpointId } : {}),
        },
      };
    case 'system_message':
      return {
        ...common,
        messageRole: 'event',
        raw: { type: 'antigravity_system', text: params.step.text },
      };
    case 'error':
      return {
        ...common,
        messageRole: 'event',
        raw: { type: 'antigravity_error', message: params.step.message },
      };
  }
}

export function projectAntigravityTranscriptRecordGroupsToExternalItems(params: Readonly<{
  conversationId: string;
  records: readonly AntigravityTranscriptRecordWithOffsets[];
}>): readonly AntigravityExternalTranscriptItemGroup[] {
  const pendingToolCallIds: string[] = [];
  return params.records.map((entry) => {
    let fallbackToolCallId = 0;
    const namespace = `${params.conversationId}-byte-${entry.startOffsetBytes}`;
    const steps = mapAntigravityTranscriptRecordToStepsWithContext(entry.record, {
      pendingToolCallIds,
      generatedIdNamespace: namespace,
      nextFallbackToolCallId: () => `antigravity-turn-${namespace}-tool-${fallbackToolCallId += 1}`,
    });
    const createdAtMs = readCreatedAtMs(entry.record);
    return {
      startOffsetBytes: entry.startOffsetBytes,
      endOffsetBytes: entry.endOffsetBytes,
      items: steps.map((step, index) => projectStep({
        step,
        createdAtMs,
        fallbackId: `antigravity-${params.conversationId}-byte-${entry.startOffsetBytes}-item-${index + 1}`,
      })),
    };
  });
}

export function projectAntigravityTranscriptRecordsToExternalItems(params: Readonly<{
  conversationId: string;
  records: readonly AntigravityTranscriptRecordWithOffsets[];
}>): readonly AgentExternalSessionTranscriptItem[] {
  return projectAntigravityTranscriptRecordGroupsToExternalItems(params)
    .flatMap((group) => group.items);
}
