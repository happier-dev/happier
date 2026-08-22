import {
  mapAntigravityStepsToRuntimeEvents,
  normalizeAntigravityToolName,
  type AntigravityStep,
} from '../../normalize/index.js';
import {
  AgentExternalSessionTranscriptRawRecordSchema,
  type AgentExternalSessionLinkDataValue,
  type AgentExternalSessionTranscriptItem,
} from '@happier-dev/plugin-sdk/sessions/external';

type AgentExternalSessionTranscriptRawRecord = AgentExternalSessionTranscriptItem['raw'];

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

const USER_REQUEST_OPEN_TAG = '<USER_REQUEST>';
const USER_REQUEST_CLOSE_TAG = '</USER_REQUEST>';
const ADDITIONAL_METADATA_TAGS = ['<ADDITIONAL_METADATA>', '</ADDITIONAL_METADATA>'] as const;

function firstIndexOfAny(text: string, tags: readonly string[]): number {
  let earliest = -1;
  for (const tag of tags) {
    const index = text.indexOf(tag);
    if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index;
  }
  return earliest;
}

function occurrences(text: string, tag: string): number {
  let count = 0;
  for (let index = text.indexOf(tag); index >= 0; index = text.indexOf(tag, index + tag.length)) {
    count += 1;
  }
  return count;
}

/**
 * Antigravity wraps every user turn in its own prompt scaffolding: the typed
 * request inside `<USER_REQUEST>` plus `<ADDITIONAL_METADATA>` the CLI appends
 * (open editor paths and other workspace context the user never wrote). This is
 * the single place that strips it, so the classified step feeds candidate
 * titles, transcript rows, and prompt correlation with the same user-authored
 * text.
 *
 * The metadata block is workspace context that shared recipients must never
 * see, so anything other than exactly one terminated `<USER_REQUEST>` block
 * whose metadata follows it fails closed with an empty body: the caller then
 * omits the user row and the derived title instead of emitting scaffolding.
 */
export function readAntigravityUserRequestBody(text: string): string {
  const metadataIndex = firstIndexOfAny(text, ADDITIONAL_METADATA_TAGS);
  const openIndex = text.indexOf(USER_REQUEST_OPEN_TAG);
  if (openIndex < 0) return metadataIndex < 0 ? text : '';
  if (
    occurrences(text, USER_REQUEST_OPEN_TAG) !== 1
    || occurrences(text, USER_REQUEST_CLOSE_TAG) !== 1
  ) {
    return '';
  }
  const bodyStart = openIndex + USER_REQUEST_OPEN_TAG.length;
  const closeIndex = text.indexOf(USER_REQUEST_CLOSE_TAG, bodyStart);
  if (closeIndex < 0) return '';
  return metadataIndex >= 0 && metadataIndex < closeIndex
    ? ''
    : text.slice(bodyStart, closeIndex);
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

const ANTIGRAVITY_USER_RECORD_TYPES = ['user_input', 'user', 'user_message'] as const;
const ANTIGRAVITY_ASSISTANT_RECORD_TYPES = [
  'planner_response',
  'assistant',
  'assistant_message',
  'conversation_history',
] as const;
const ANTIGRAVITY_TYPED_TOOL_RECORD_TYPES = [
  'run_command',
  'code_action',
  'list_directory',
  'view_file',
  'file_action',
] as const;
const ANTIGRAVITY_TOOL_RESULT_RECORD_TYPES = ['tool_result', 'command_result', 'action_result'] as const;
const ANTIGRAVITY_SYSTEM_RECORD_TYPES = ['system_message', 'system'] as const;

const ANTIGRAVITY_KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set<string>([
  ...ANTIGRAVITY_USER_RECORD_TYPES,
  ...ANTIGRAVITY_ASSISTANT_RECORD_TYPES,
  ...ANTIGRAVITY_TYPED_TOOL_RECORD_TYPES,
  ...ANTIGRAVITY_TOOL_RESULT_RECORD_TYPES,
  ...ANTIGRAVITY_SYSTEM_RECORD_TYPES,
  'checkpoint',
  'error',
]);

/**
 * Whether this mapper recognizes the record's own declared kind.
 *
 * A recognized record that projects to no transcript item (a checkpoint, an
 * empty system message) is a deliberate omission. An UNRECOGNIZED nonempty
 * record is Antigravity history this build cannot read, which readers must be
 * able to tell apart from an omission before they finalize a transcript.
 */
export function isKnownAntigravityTranscriptRecord(record: JsonRecord): boolean {
  const type = (readString(record.type) ?? readString(record.eventType))?.toLowerCase();
  return Boolean(type) && ANTIGRAVITY_KNOWN_RECORD_TYPES.has(type!);
}

function mapAntigravityTranscriptRecordToStepsWithContext(
  record: JsonRecord,
  context?: TranscriptMappingContext,
): readonly AntigravityStep[] {
  const type = (readString(record.type) ?? readString(record.eventType))?.toLowerCase();
  const id = readStepIdentity(record, context);
  if (!type) return [];
  if ((ANTIGRAVITY_USER_RECORD_TYPES as readonly string[]).includes(type)) {
    const text = readText(record);
    const requested = text ? readAntigravityUserRequestBody(text).trim() : '';
    return requested ? [{ ...(id ? { id } : {}), kind: 'user_message', text: requested }] : [];
  }
  if ((ANTIGRAVITY_ASSISTANT_RECORD_TYPES as readonly string[]).includes(type)) {
    const text = readText(record);
    return [
      ...(text ? [{ ...(id ? { id } : {}), kind: 'assistant_message' as const, text }] : []),
      ...mapPlannerToolCalls(record, context),
    ];
  }
  if ((ANTIGRAVITY_TYPED_TOOL_RECORD_TYPES as readonly string[]).includes(type)) {
    return [mapTypedToolResult(record, context)];
  }
  if ((ANTIGRAVITY_TOOL_RESULT_RECORD_TYPES as readonly string[]).includes(type)) {
    return [mapTypedToolResult(record, context)];
  }
  if (type === 'checkpoint') {
    return [{
      ...(id ? { id } : {}),
      kind: 'checkpoint',
      ...(readString(record.checkpointId) ? { checkpointId: readString(record.checkpointId) ?? undefined } : {}),
    }];
  }
  if ((ANTIGRAVITY_SYSTEM_RECORD_TYPES as readonly string[]).includes(type)) {
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
  /**
   * The record's own kind is not one this build reads. Distinct from an empty
   * `items` list, which a recognized record may legitimately produce.
   */
  unsupported: boolean;
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

/**
 * Canonical current Agent transcript envelope. The Protocol schema is the
 * admission boundary; this mapper uses it to keep this producer from emitting
 * source-local events that no host consumer can interpret.
 */
function toAgentRaw(
  data: AgentExternalSessionLinkDataValue,
): AgentExternalSessionTranscriptRawRecord {
  return AgentExternalSessionTranscriptRawRecordSchema.parse({
    role: 'agent',
    content: { type: 'acp', agentId: 'antigravity', data },
  });
}

function toUserRaw(text: string): AgentExternalSessionTranscriptRawRecord {
  return { role: 'user', content: { type: 'text', text } };
}

function projectStep(params: Readonly<{
  step: AntigravityStep;
  fallbackId: string;
  createdAtMs: number;
}>): AgentExternalSessionTranscriptItem | null {
  const id = params.step.id ?? params.fallbackId;
  const localId = params.step.id;
  const common = {
    id,
    createdAtMs: params.createdAtMs,
    ...(localId ? { localId } : {}),
  };
  switch (params.step.kind) {
    case 'user_message':
      return { ...common, messageRole: 'user', raw: toUserRaw(params.step.text) };
    case 'assistant_message':
      return {
        ...common,
        messageRole: 'agent',
        raw: toAgentRaw({ type: 'message', message: params.step.text }),
      };
    case 'tool_call':
      return {
        ...common,
        messageRole: 'event',
        raw: toAgentRaw({
          type: 'tool-call',
          callId: id,
          name: params.step.toolName,
          input: toLinkDataValue(params.step.input),
          id,
        }),
      };
    case 'tool_result':
      return {
        ...common,
        messageRole: 'event',
        raw: toAgentRaw({
          type: 'tool-result',
          callId: params.step.toolCallId,
          output: toLinkDataValue(params.step.output),
          id,
          ...(params.step.isError !== undefined ? { isError: params.step.isError } : {}),
        }),
      };
    case 'checkpoint':
    case 'system_message':
      // These source-local records have no canonical ACP transcript event.
      return null;
    case 'error':
      return {
        ...common,
        messageRole: 'event',
        // The source diagnostic stays in the runtime diagnostic owner; history
        // carries only the canonical terminal event.
        raw: toAgentRaw({ type: 'turn_failed', id }),
      };
  }
}

export function projectAntigravityTranscriptRecordGroupsToExternalItems(params: Readonly<{
  conversationId: string;
  records: readonly AntigravityTranscriptRecordWithOffsets[];
}>): readonly AntigravityExternalTranscriptItemGroup[] {
  return projectAntigravityTranscriptRecordGroupsWithCorrelation({
    conversationId: params.conversationId,
    records: params.records,
  }).groups;
}

export function projectAntigravityTranscriptRecordGroupsWithCorrelation(params: Readonly<{
  conversationId: string;
  records: readonly AntigravityTranscriptRecordWithOffsets[];
  pendingToolCallIds?: readonly string[];
}>): Readonly<{
  groups: readonly AntigravityExternalTranscriptItemGroup[];
  pendingToolCallIds: readonly string[];
}> {
  const pendingToolCallIds = [...(params.pendingToolCallIds ?? [])];
  const groups = params.records.map((entry) => {
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
      unsupported: Object.keys(entry.record).length > 0
        && !isKnownAntigravityTranscriptRecord(entry.record),
      items: steps.flatMap((step, index) => {
        const item = projectStep({
          step,
          createdAtMs,
          fallbackId: `antigravity-${params.conversationId}-byte-${entry.startOffsetBytes}-item-${index + 1}`,
        });
        return item ? [item] : [];
      }),
    };
  });
  return { groups, pendingToolCallIds };
}

export function projectAntigravityTranscriptRecordsToExternalItems(params: Readonly<{
  conversationId: string;
  records: readonly AntigravityTranscriptRecordWithOffsets[];
}>): readonly AgentExternalSessionTranscriptItem[] {
  return projectAntigravityTranscriptRecordGroupsToExternalItems(params)
    .flatMap((group) => group.items);
}
