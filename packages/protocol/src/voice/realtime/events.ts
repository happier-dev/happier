import { lazyZodSchema } from '../../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { z } from '../../zodRuntimePolicy.js';

const REALTIME_ID_MAX_LENGTH = 256;
const TRANSCRIPT_TEXT_MAX_LENGTH = 256 * 1024;
const TOOL_NAME_MAX_LENGTH = 128;
const JSON_MAX_DEPTH = 16;
const JSON_MAX_COLLECTION_ITEMS = 256;
const JSON_MAX_STRING_LENGTH = 64 * 1024;

export type VoiceRealtimeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly VoiceRealtimeJsonValue[]
  | { readonly [key: string]: VoiceRealtimeJsonValue };

function createJsonValueSchema(depthRemaining: number): z.ZodMiniType<VoiceRealtimeJsonValue> {
  const scalarSchema = z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string().check(z.maxLength(JSON_MAX_STRING_LENGTH)),
  ]);
  if (depthRemaining === 0) return scalarSchema;

  const childSchema = createJsonValueSchema(depthRemaining - 1);
  const objectSchema = z.record(
    z.string().check(z.maxLength(REALTIME_ID_MAX_LENGTH)),
    childSchema,
  ).check(z.superRefine((value, ctx) => {
    if (Object.keys(value).length > JSON_MAX_COLLECTION_ITEMS) {
      ctx.addIssue({ code: 'custom', message: 'JSON object has too many keys' });
    }
  }));
  return z.union([
    scalarSchema,
    z.array(childSchema).check(z.maxLength(JSON_MAX_COLLECTION_ITEMS)),
    objectSchema,
  ]);
}

export const VoiceRealtimeJsonValueSchema = createJsonValueSchema(JSON_MAX_DEPTH);

function containsOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return false;
  }
  return true;
}

export const VoiceRealtimeStableIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(REALTIME_ID_MAX_LENGTH), z.refine((value) => value.trim() === value, { message: 'opaque identifiers must not be normalized' }), z.refine(containsOnlyUnicodeScalarValues, { message: 'opaque identifiers must contain only Unicode scalar values' })));
const TranscriptBaseSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  epoch: z.number().check(z.int(), z.nonnegative()),
  sequence: z.number().check(z.int(), z.nonnegative()),
  revision: z.number().check(z.int(), z.positive()),
  eventId: VoiceRealtimeStableIdSchema,
  itemId: VoiceRealtimeStableIdSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string().check(z.maxLength(TRANSCRIPT_TEXT_MAX_LENGTH)),
  provenance: z.enum(['live', 'replay']),
}));

export const VoiceTranscriptCanonicalEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TranscriptBaseSchema, { type: z.literal('voice.transcript.updated') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TranscriptBaseSchema, { type: z.literal('voice.transcript.delta') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TranscriptBaseSchema, { type: z.literal('voice.transcript.final') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TranscriptBaseSchema, { type: z.literal('voice.transcript.corrected') })),
]));
export type VoiceTranscriptCanonicalEventV1 = z.infer<typeof VoiceTranscriptCanonicalEventV1Schema>;

export const VoiceRealtimeToolCallV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  responseId: VoiceRealtimeStableIdSchema,
  callId: VoiceRealtimeStableIdSchema,
  toolName: z.string().check(z.trim(), z.minLength(1), z.maxLength(TOOL_NAME_MAX_LENGTH)),
  order: z.number().check(z.int(), z.nonnegative()),
  arguments: VoiceRealtimeJsonValueSchema,
}));
export type VoiceRealtimeToolCallV1 = z.infer<typeof VoiceRealtimeToolCallV1Schema>;

export const VoiceRealtimeToolResultStatusSchema = lazyZodSchema(() => z.enum([
  'success',
  'denied',
  'error',
  'cancelled',
  'timeout',
]));
export type VoiceRealtimeToolResultStatus = z.infer<typeof VoiceRealtimeToolResultStatusSchema>;

export const VoiceRealtimeToolResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  responseId: VoiceRealtimeStableIdSchema,
  callId: VoiceRealtimeStableIdSchema,
  toolName: z.string().check(z.trim(), z.minLength(1), z.maxLength(TOOL_NAME_MAX_LENGTH)),
  order: z.number().check(z.int(), z.nonnegative()),
  status: VoiceRealtimeToolResultStatusSchema,
  output: z.optional(StrictJsonValueSchema),
  /** Human outcome produced by the host after its privacy projection. */
  summary: z.optional(z.string()),
  errorCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
  errorDetails: z.optional(StrictJsonValueSchema),
}).check(z.superRefine((value, ctx) => {
  if (value.status === 'success') {
    if (value.output === undefined) {
      ctx.addIssue({ code: 'custom', path: ['output'], message: 'success requires output' });
    }
    if (value.errorCode !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['errorCode'], message: 'success forbids errorCode' });
    }
    if (value.errorDetails !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['errorDetails'], message: 'success forbids errorDetails' });
    }
    return;
  }
  if (value.output !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['output'], message: 'non-success results forbid output' });
  }
  if (value.errorCode === undefined) {
    ctx.addIssue({ code: 'custom', path: ['errorCode'], message: 'non-success results require errorCode' });
  }
})));
export type VoiceRealtimeToolResultV1 = z.infer<typeof VoiceRealtimeToolResultV1Schema>;

/** Provider wire adapters serialize the host's already-redacted terminal result. */
export function projectVoiceRealtimeToolResultOutput(result: VoiceRealtimeToolResultV1): VoiceRealtimeJsonValue {
  if (result.status === 'success') {
    if (result.summary === undefined) return result.output!;
    const output = result.output;
    return output !== null && typeof output === 'object' && !Array.isArray(output)
      ? { ...output, summary: result.summary }
      : { value: output!, summary: result.summary };
  }
  return {
    ok: false,
    errorCode: result.errorCode!,
    ...(result.errorDetails === undefined ? {} : { details: result.errorDetails }),
    ...(result.summary === undefined ? {} : { summary: result.summary }),
  };
}
