import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { VoiceAssistantActionSchema, type VoiceAssistantAction } from './actions.js';
import { resolveVoiceSpeechSegmentLength, speechTextEndAtOrBefore } from './speechText.js';

const VoiceOutputIdSchema = lazyZodSchema(() => z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/));
const VoiceOutputTurnIdSchema = VoiceOutputIdSchema;
const VoiceOutputSequenceSchema = lazyZodSchema(() => z.number().int().min(0).max(4_095));
const MAX_SPEECH_SEGMENT_CHARACTERS = 16_384;
const VoiceSpeechTextSchema = lazyZodSchema(() => z.string().min(1).max(MAX_SPEECH_SEGMENT_CHARACTERS));
const VoiceStatusTextSchema = lazyZodSchema(() => z.string().min(1).max(1_024));
const VoiceFinalTextSchema = lazyZodSchema(() => z.string().max(65_536));

const VoiceAgentOutputBaseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  turnId: VoiceOutputTurnIdSchema,
  seq: VoiceOutputSequenceSchema,
}).strict());

export const VoiceAgentSpeechSegmentEventV1Schema = lazyZodSchema(() => VoiceAgentOutputBaseV1Schema.extend({
  kind: z.literal('speech_segment'),
  segmentId: VoiceOutputIdSchema,
  text: VoiceSpeechTextSchema,
}).strict());

export const VoiceAgentDisplayStatusEventV1Schema = lazyZodSchema(() => VoiceAgentOutputBaseV1Schema.extend({
  kind: z.literal('display_status'),
  statusId: VoiceOutputIdSchema,
  text: VoiceStatusTextSchema,
}).strict());

export const VoiceAgentSideEffectEventV1Schema = lazyZodSchema(() => VoiceAgentOutputBaseV1Schema.extend({
  kind: z.literal('side_effect'),
  effectId: VoiceOutputIdSchema,
  action: VoiceAssistantActionSchema,
}).strict());

export const VoiceAgentTurnFinalEventV1Schema = lazyZodSchema(() => VoiceAgentOutputBaseV1Schema.extend({
  kind: z.literal('turn_final'),
  text: VoiceFinalTextSchema,
}).strict());

export const VoiceAgentTurnCancelledEventV1Schema = lazyZodSchema(() => VoiceAgentOutputBaseV1Schema.extend({
  kind: z.literal('turn_cancelled'),
}).strict());

export const VoiceAgentOutputEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  VoiceAgentSpeechSegmentEventV1Schema,
  VoiceAgentDisplayStatusEventV1Schema,
  VoiceAgentSideEffectEventV1Schema,
  VoiceAgentTurnFinalEventV1Schema,
  VoiceAgentTurnCancelledEventV1Schema,
]));

export type VoiceAgentOutputEventV1 = z.infer<typeof VoiceAgentOutputEventV1Schema>;

export type VoiceAgentOutputEffectV1 =
  | Readonly<{ kind: 'speak'; segmentId: string; text: string }>
  | Readonly<{ kind: 'display_status'; statusId: string; text: string }>
  | Readonly<{ kind: 'execute_side_effect'; effectId: string; action: VoiceAssistantAction }>
  | Readonly<{ kind: 'persist_final'; text: string }>
  | Readonly<{ kind: 'cancel_turn' }>;

export type VoiceAgentOutputTurnV1 = Readonly<{
  turnId: string;
  nextSeq: number;
  eventCount: number;
  payloadBytes: number;
  terminal: 'open' | 'final' | 'cancelled';
  spokeAnySegment: boolean;
  seenSegmentIds: ReadonlySet<string>;
  seenStatusIds: ReadonlySet<string>;
  seenEffectIds: ReadonlySet<string>;
}>;

const MAX_EVENTS_PER_TURN = 256;
const MAX_PAYLOAD_BYTES_PER_TURN = 256 * 1024;
export const VOICE_OUTPUT_INCOMPLETE_TEXT = '\n\n[Voice output incomplete: turn output budget reached.]';

/** Pack semantic speech into the existing wire envelope without discarding its remainder. */
export function resolveVoiceAgentOutputSpeechSegmentLength(
  text: string,
  options: Parameters<typeof resolveVoiceSpeechSegmentLength>[1],
): number {
  const semanticLength = resolveVoiceSpeechSegmentLength(text, options);
  const length = semanticLength || (text.length >= MAX_SPEECH_SEGMENT_CHARACTERS ? MAX_SPEECH_SEGMENT_CHARACTERS : 0);
  const end = speechTextEndAtOrBefore(text, Math.min(length, MAX_SPEECH_SEGMENT_CHARACTERS));
  if (end < length || semanticLength === 0) {
    for (let index = end - 1; index >= 0; index -= 1) {
      if (/\s/u.test(text[index]!)) return index + 1;
    }
  }
  return end;
}

function payloadByteLength(event: VoiceAgentOutputEventV1): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

function fitsVoiceOutputBudget(eventCount: number, payloadBytes: number): boolean {
  return eventCount <= MAX_EVENTS_PER_TURN && payloadBytes <= MAX_PAYLOAD_BYTES_PER_TURN;
}

/** Producer admission uses the same serialized budget as the receiving ingestor. */
export function canAppendVoiceAgentOutputEventsV1(
  state: VoiceAgentOutputTurnV1,
  events: readonly VoiceAgentOutputEventV1[],
): boolean {
  return events.every((event) => VoiceAgentOutputEventV1Schema.safeParse(event).success)
    && fitsVoiceOutputBudget(
      state.eventCount + events.length,
      state.payloadBytes + events.reduce((bytes, event) => bytes + payloadByteLength(event), 0),
    );
}

/** Reserve the repeated final while admitting speech; clip only at a Unicode boundary. */
export function fitVoiceAgentOutputTextV1(
  state: VoiceAgentOutputTurnV1,
  event: Extract<VoiceAgentOutputEventV1, { kind: 'speech_segment' | 'turn_final' }>,
  finalTextPrefix = '',
  finalTextSuffix = event.kind === 'speech_segment' ? VOICE_OUTPUT_INCOMPLETE_TEXT : '',
): string {
  const fits = (text: string) => canAppendVoiceAgentOutputEventsV1(state, [
    { ...event, text: event.kind === 'turn_final' ? `${text}${finalTextSuffix}` : text },
    ...(event.kind === 'speech_segment' ? [{
      v: 1 as const, kind: 'turn_final' as const, turnId: event.turnId, seq: event.seq + 1,
      text: `${finalTextPrefix}${text}${finalTextSuffix}`,
    }] : []),
  ]);
  if (fits(event.text)) return event.text;
  let low = 0;
  let high = event.text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const end = speechTextEndAtOrBefore(event.text, middle);
    if (fits(event.text.slice(0, end))) low = middle;
    else high = middle - 1;
  }
  return event.text.slice(0, speechTextEndAtOrBefore(event.text, low));
}

function eventStableId(event: VoiceAgentOutputEventV1): Readonly<{ kind: 'segment' | 'status' | 'effect'; id: string }> | null {
  if (event.kind === 'speech_segment') return { kind: 'segment', id: event.segmentId };
  if (event.kind === 'display_status') return { kind: 'status', id: event.statusId };
  if (event.kind === 'side_effect') return { kind: 'effect', id: event.effectId };
  return null;
}

function wasSeen(state: VoiceAgentOutputTurnV1, stableId: NonNullable<ReturnType<typeof eventStableId>>): boolean {
  if (stableId.kind === 'segment') return state.seenSegmentIds.has(stableId.id);
  if (stableId.kind === 'status') return state.seenStatusIds.has(stableId.id);
  return state.seenEffectIds.has(stableId.id);
}

export function createVoiceAgentOutputTurnV1(turnId: string): VoiceAgentOutputTurnV1 {
  const parsedTurnId = VoiceOutputTurnIdSchema.parse(turnId);
  return Object.freeze({
    turnId: parsedTurnId,
    nextSeq: 0,
    eventCount: 0,
    payloadBytes: 0,
    terminal: 'open' as const,
    spokeAnySegment: false,
    seenSegmentIds: new Set<string>(),
    seenStatusIds: new Set<string>(),
    seenEffectIds: new Set<string>(),
  });
}

export function ingestVoiceAgentOutputEventV1(
  state: VoiceAgentOutputTurnV1,
  rawEvent: VoiceAgentOutputEventV1,
): Readonly<{ state: VoiceAgentOutputTurnV1; effects: readonly VoiceAgentOutputEffectV1[] }> {
  const event = VoiceAgentOutputEventV1Schema.parse(rawEvent);
  if (event.turnId !== state.turnId) throw new Error('voice_output_turn_mismatch');
  if (state.terminal !== 'open') return { state, effects: [] };

  const stableId = eventStableId(event);
  if (stableId && wasSeen(state, stableId)) return { state, effects: [] };
  if (event.seq !== state.nextSeq) throw new Error('voice_output_sequence_invalid');

  const nextEventCount = state.eventCount + 1;
  const nextPayloadBytes = state.payloadBytes + payloadByteLength(event);
  if (!fitsVoiceOutputBudget(nextEventCount, nextPayloadBytes)) {
    throw new Error('voice_output_budget_exceeded');
  }

  const seenSegmentIds = new Set(state.seenSegmentIds);
  const seenStatusIds = new Set(state.seenStatusIds);
  const seenEffectIds = new Set(state.seenEffectIds);
  if (stableId?.kind === 'segment') seenSegmentIds.add(stableId.id);
  if (stableId?.kind === 'status') seenStatusIds.add(stableId.id);
  if (stableId?.kind === 'effect') seenEffectIds.add(stableId.id);

  let terminal: VoiceAgentOutputTurnV1['terminal'] = state.terminal;
  let spokeAnySegment = state.spokeAnySegment;
  const effects: VoiceAgentOutputEffectV1[] = [];
  if (event.kind === 'speech_segment') {
    spokeAnySegment = true;
    effects.push({ kind: 'speak', segmentId: event.segmentId, text: event.text });
  } else if (event.kind === 'display_status') {
    effects.push({ kind: 'display_status', statusId: event.statusId, text: event.text });
  } else if (event.kind === 'side_effect') {
    effects.push({ kind: 'execute_side_effect', effectId: event.effectId, action: event.action });
  } else if (event.kind === 'turn_final') {
    terminal = 'final';
    if (!spokeAnySegment && event.text.trim()) {
      effects.push({ kind: 'speak', segmentId: `${state.turnId}:final`, text: event.text });
      spokeAnySegment = true;
    }
    effects.push({ kind: 'persist_final', text: event.text });
  } else {
    terminal = 'cancelled';
    effects.push({ kind: 'cancel_turn' });
  }

  return {
    state: Object.freeze({
      turnId: state.turnId,
      nextSeq: state.nextSeq + 1,
      eventCount: nextEventCount,
      payloadBytes: nextPayloadBytes,
      terminal,
      spokeAnySegment,
      seenSegmentIds,
      seenStatusIds,
      seenEffectIds,
    }),
    effects,
  };
}
