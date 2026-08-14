import { z } from 'zod';

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

function createJsonValueSchema(depthRemaining: number): z.ZodType<VoiceRealtimeJsonValue> {
  const scalarSchema = z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(JSON_MAX_STRING_LENGTH),
  ]);
  if (depthRemaining === 0) return scalarSchema;

  const childSchema = createJsonValueSchema(depthRemaining - 1);
  const objectSchema = z.record(
    z.string().max(REALTIME_ID_MAX_LENGTH),
    childSchema,
  ).superRefine((value, ctx) => {
    if (Object.keys(value).length > JSON_MAX_COLLECTION_ITEMS) {
      ctx.addIssue({ code: 'custom', message: 'JSON object has too many keys' });
    }
  });
  return z.union([
    scalarSchema,
    z.array(childSchema).max(JSON_MAX_COLLECTION_ITEMS),
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

export const VoiceRealtimeStableIdSchema = z.string()
  .min(1)
  .max(REALTIME_ID_MAX_LENGTH)
  .refine((value) => value.trim() === value, { message: 'opaque identifiers must not be normalized' })
  .refine(containsOnlyUnicodeScalarValues, { message: 'opaque identifiers must contain only Unicode scalar values' });
const TranscriptBaseSchema = z.object({
  v: z.literal(1),
  epoch: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  eventId: VoiceRealtimeStableIdSchema,
  itemId: VoiceRealtimeStableIdSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string().max(TRANSCRIPT_TEXT_MAX_LENGTH),
  provenance: z.enum(['live', 'replay']),
}).strict();

export const VoiceTranscriptCanonicalEventV1Schema = z.discriminatedUnion('type', [
  TranscriptBaseSchema.extend({ type: z.literal('voice.transcript.updated') }).strict(),
  TranscriptBaseSchema.extend({ type: z.literal('voice.transcript.delta') }).strict(),
  TranscriptBaseSchema.extend({ type: z.literal('voice.transcript.final') }).strict(),
  TranscriptBaseSchema.extend({ type: z.literal('voice.transcript.corrected') }).strict(),
]);
export type VoiceTranscriptCanonicalEventV1 = z.infer<typeof VoiceTranscriptCanonicalEventV1Schema>;

export const VoiceRealtimeToolCallV1Schema = z.object({
  v: z.literal(1),
  responseId: VoiceRealtimeStableIdSchema,
  callId: VoiceRealtimeStableIdSchema,
  toolName: z.string().trim().min(1).max(TOOL_NAME_MAX_LENGTH),
  order: z.number().int().nonnegative(),
  arguments: VoiceRealtimeJsonValueSchema,
}).strict();
export type VoiceRealtimeToolCallV1 = z.infer<typeof VoiceRealtimeToolCallV1Schema>;

export const VoiceRealtimeToolResultStatusSchema = z.enum([
  'success',
  'denied',
  'error',
  'cancelled',
  'timeout',
]);
export type VoiceRealtimeToolResultStatus = z.infer<typeof VoiceRealtimeToolResultStatusSchema>;

export const VoiceRealtimeToolResultV1Schema = z.object({
  v: z.literal(1),
  responseId: VoiceRealtimeStableIdSchema,
  callId: VoiceRealtimeStableIdSchema,
  toolName: z.string().trim().min(1).max(TOOL_NAME_MAX_LENGTH),
  order: z.number().int().nonnegative(),
  status: VoiceRealtimeToolResultStatusSchema,
  output: VoiceRealtimeJsonValueSchema.optional(),
  errorCode: z.string().trim().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'success') {
    if (value.output === undefined) {
      ctx.addIssue({ code: 'custom', path: ['output'], message: 'success requires output' });
    }
    if (value.errorCode !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['errorCode'], message: 'success forbids errorCode' });
    }
    return;
  }
  if (value.output !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['output'], message: 'non-success results forbid output' });
  }
  if (value.errorCode === undefined) {
    ctx.addIssue({ code: 'custom', path: ['errorCode'], message: 'non-success results require errorCode' });
  }
});
export type VoiceRealtimeToolResultV1 = z.infer<typeof VoiceRealtimeToolResultV1Schema>;
