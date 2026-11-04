import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { VoiceAssistantActionSchema, type VoiceAssistantAction } from './actions.js';
import { normalizeVoiceSpeechTextChunk, resolveVoiceSpeechSegmentLength, speechTextEndAtOrBefore, toSpeechText, type VoiceSpeechTextState } from './speechText.js';

const VoiceOutputIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(128), z.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)));
const VoiceOutputTurnIdSchema = VoiceOutputIdSchema;
const VoiceOutputSequenceSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(4_095)));
const MAX_SPEECH_SEGMENT_CHARACTERS = 16_384;
const VoiceSpeechTextSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(MAX_SPEECH_SEGMENT_CHARACTERS)));
const VoiceStatusTextSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(1_024)));
const VoiceFinalTextSchema = lazyZodSchema(() => z.string().check(z.maxLength(65_536)));

const VoiceAgentOutputBaseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  turnId: VoiceOutputTurnIdSchema,
  seq: VoiceOutputSequenceSchema,
}));

export const VoiceAgentSpeechSegmentEventV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceAgentOutputBaseV1Schema, {
  kind: z.literal('speech_segment'),
  segmentId: VoiceOutputIdSchema,
  text: VoiceSpeechTextSchema,
})));

export const VoiceAgentDisplayStatusEventV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceAgentOutputBaseV1Schema, {
  kind: z.literal('display_status'),
  statusId: VoiceOutputIdSchema,
  text: VoiceStatusTextSchema,
})));

export const VoiceAgentSideEffectEventV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceAgentOutputBaseV1Schema, {
  kind: z.literal('side_effect'),
  effectId: VoiceOutputIdSchema,
  action: VoiceAssistantActionSchema,
})));

export const VoiceAgentTurnFinalEventV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceAgentOutputBaseV1Schema, {
  kind: z.literal('turn_final'),
  text: VoiceFinalTextSchema,
})));

export const VoiceAgentTurnCancelledEventV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceAgentOutputBaseV1Schema, {
  kind: z.literal('turn_cancelled'),
})));

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
  terminal: 'open' | 'final' | 'cancelled';
  spokeAnySegment: boolean;
  speechTextState: VoiceSpeechTextState | null;
  seenSegmentIds: ReadonlySet<string>;
  seenStatusIds: ReadonlySet<string>;
  seenEffectIds: ReadonlySet<string>;
}>;

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

/** Producer admission preserves the receiving wire envelope, not a per-turn quota. */
export function canAppendVoiceAgentOutputEventsV1(
  _state: VoiceAgentOutputTurnV1,
  events: readonly VoiceAgentOutputEventV1[],
): boolean {
  return events.every((event) => VoiceAgentOutputEventV1Schema.safeParse(event).success);
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
    terminal: 'open' as const,
    spokeAnySegment: false,
    speechTextState: null,
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

  const seenSegmentIds = new Set(state.seenSegmentIds);
  const seenStatusIds = new Set(state.seenStatusIds);
  const seenEffectIds = new Set(state.seenEffectIds);
  if (stableId?.kind === 'segment') seenSegmentIds.add(stableId.id);
  if (stableId?.kind === 'status') seenStatusIds.add(stableId.id);
  if (stableId?.kind === 'effect') seenEffectIds.add(stableId.id);

  let terminal: VoiceAgentOutputTurnV1['terminal'] = state.terminal;
  let spokeAnySegment = state.spokeAnySegment;
  let speechTextState = state.speechTextState;
  const effects: VoiceAgentOutputEffectV1[] = [];
  if (event.kind === 'speech_segment') {
    spokeAnySegment = true;
    const speech = normalizeVoiceSpeechTextChunk(event.text, speechTextState);
    speechTextState = speech.state;
    if (speech.text.trim()) effects.push({ kind: 'speak', segmentId: event.segmentId, text: speech.text });
  } else if (event.kind === 'display_status') {
    effects.push({ kind: 'display_status', statusId: event.statusId, text: event.text });
  } else if (event.kind === 'side_effect') {
    effects.push({ kind: 'execute_side_effect', effectId: event.effectId, action: event.action });
  } else if (event.kind === 'turn_final') {
    terminal = 'final';
    if (!spokeAnySegment && event.text.trim()) {
      const text = toSpeechText(event.text);
      if (text) effects.push({ kind: 'speak', segmentId: `${state.turnId}:final`, text });
      spokeAnySegment = true;
    } else if (speechTextState) {
      const tail = normalizeVoiceSpeechTextChunk('', speechTextState, true);
      speechTextState = tail.state;
      if (tail.text.trim()) effects.push({ kind: 'speak', segmentId: `${state.turnId}:final`, text: tail.text });
    }
    speechTextState = null;
    effects.push({ kind: 'persist_final', text: event.text });
  } else {
    terminal = 'cancelled';
    speechTextState = null;
    effects.push({ kind: 'cancel_turn' });
  }

  return {
    state: Object.freeze({
      turnId: state.turnId,
      nextSeq: state.nextSeq + 1,
      terminal,
      spokeAnySegment,
      speechTextState,
      seenSegmentIds,
      seenStatusIds,
      seenEffectIds,
    }),
    effects,
  };
}
