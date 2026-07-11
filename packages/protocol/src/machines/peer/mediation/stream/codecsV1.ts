import { z } from 'zod';

import { readCanonicalPaddedBase64DecodedLength } from '../../../../crypto/base64.js';
import { getMachineLiveStreamPayloadDecodedByteLength } from './v1.js';

const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();
const Base64Schema = z.string().superRefine((value, context) => {
  if (readCanonicalPaddedBase64DecodedLength(value) !== null) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Invalid base64 payload',
  });
});

export const MachineLiveStreamCodecIdV1Schema = z.enum([
  'image.frame.v1',
  'image.mjpeg',
  'h264.avcc',
]);

export const MACHINE_LIVE_STREAM_BASELINE_CODEC_V1 = 'image.mjpeg' as const;

export const MACHINE_LIVE_STREAM_AVCC_ENVELOPE_TAGS_V1 = {
  description: 0x01,
  keyframe: 0x02,
  delta: 0x03,
  seed: 0x04,
} as const;

export type MachineLiveStreamAvccChunkTypeV1 = keyof typeof MACHINE_LIVE_STREAM_AVCC_ENVELOPE_TAGS_V1;

export const MachineLiveStreamCodecNegotiationRequestV1Schema = z
  .object({
    v: z.literal(1),
    streamId: z.string().min(1),
    sourceCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
    viewerCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
    preferredCodec: MachineLiveStreamCodecIdV1Schema.optional(),
    maxWidth: PositiveIntSchema.optional(),
    maxHeight: PositiveIntSchema.optional(),
    maxFramesPerSecond: PositiveIntSchema.optional(),
  })
  .passthrough();

export const MachineLiveStreamCodecNegotiationResultV1Schema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      codecId: MachineLiveStreamCodecIdV1Schema,
      fallbackReason: z.enum(['preferred_codec_unavailable', 'baseline_selected']).optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      reasonCode: z.enum(['no_common_codec', 'invalid_codec_request']),
    })
    .passthrough(),
]);

export const MachineLiveStreamPayloadV2Schema = z
  .object({
    v: z.literal(1),
    streamId: z.string().min(1),
    sequence: PositiveIntSchema,
    timestampMs: NonNegativeIntSchema,
    codecId: MachineLiveStreamCodecIdV1Schema,
    payloadKind: z.enum(['image_frame', 'mjpeg_frame', 'h264_avcc']),
    payloadEncoding: z.literal('binary_base64'),
    payloadBase64: Base64Schema,
    payloadSizeBytes: NonNegativeIntSchema,
    keyframe: z.boolean().optional(),
    width: PositiveIntSchema.optional(),
    height: PositiveIntSchema.optional(),
    orientation: z.enum(['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight']).optional(),
    scale: z.number().positive().optional(),
    pixelRatio: z.number().positive().optional(),
    droppedFrames: NonNegativeIntSchema.optional(),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    const decodedBytes = getMachineLiveStreamPayloadDecodedByteLength(payload.payloadBase64);
    if (decodedBytes !== payload.payloadSizeBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payloadSizeBytes'],
        message: 'Live-stream payload advisory size must match decoded payload bytes',
      });
    }
    if (payload.codecId === 'h264.avcc' && payload.payloadKind !== 'h264_avcc') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payloadKind'],
        message: 'H.264 AVCC codec requires h264_avcc payloads',
      });
    }
    if (payload.payloadKind === 'h264_avcc' && payload.codecId !== 'h264.avcc') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codecId'],
        message: 'h264_avcc payloads require h264.avcc codec',
      });
    }
  });

export type MachineLiveStreamCodecIdV1 = z.infer<typeof MachineLiveStreamCodecIdV1Schema>;
export type MachineLiveStreamCodecNegotiationRequestV1 = z.infer<
  typeof MachineLiveStreamCodecNegotiationRequestV1Schema
>;
export type MachineLiveStreamCodecNegotiationResultV1 = z.infer<
  typeof MachineLiveStreamCodecNegotiationResultV1Schema
>;
export type MachineLiveStreamPayloadV2 = z.infer<typeof MachineLiveStreamPayloadV2Schema>;

const MACHINE_LIVE_STREAM_AVCC_CHUNK_TYPES_BY_TAG_V1 = new Map<number, MachineLiveStreamAvccChunkTypeV1>(
  Object.entries(MACHINE_LIVE_STREAM_AVCC_ENVELOPE_TAGS_V1).map(([type, tag]) => [
    tag,
    type as MachineLiveStreamAvccChunkTypeV1,
  ]),
);

export function resolveMachineLiveStreamAvccChunkTypeV1(tag: number): MachineLiveStreamAvccChunkTypeV1 | null {
  return MACHINE_LIVE_STREAM_AVCC_CHUNK_TYPES_BY_TAG_V1.get(tag) ?? null;
}

export function buildMachineLiveStreamAvcCodecStringV1(description: Uint8Array): string {
  if (description.length < 4) return 'avc1.42E01E';
  const hexByte = (value: number): string => value.toString(16).padStart(2, '0');
  return `avc1.${hexByte(description[1] ?? 0)}${hexByte(description[2] ?? 0)}${hexByte(description[3] ?? 0)}`;
}

function firstCommonCodec(
  left: readonly MachineLiveStreamCodecIdV1[],
  right: readonly MachineLiveStreamCodecIdV1[],
): MachineLiveStreamCodecIdV1 | null {
  const accepted = new Set(right);
  return left.find((codecId) => accepted.has(codecId)) ?? null;
}

export function negotiateMachineLiveStreamCodecV1(input: Readonly<{
  sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
  viewerCodecs: readonly MachineLiveStreamCodecIdV1[];
  preferredCodec?: MachineLiveStreamCodecIdV1;
}>): MachineLiveStreamCodecNegotiationResultV1 {
  const sourceCodecs = [...input.sourceCodecs];
  const viewerCodecs = [...input.viewerCodecs];
  const sourceSet = new Set(sourceCodecs);
  const viewerSet = new Set(viewerCodecs);

  if (input.preferredCodec && sourceSet.has(input.preferredCodec) && viewerSet.has(input.preferredCodec)) {
    return { ok: true, codecId: input.preferredCodec };
  }

  if (sourceSet.has(MACHINE_LIVE_STREAM_BASELINE_CODEC_V1) && viewerSet.has(MACHINE_LIVE_STREAM_BASELINE_CODEC_V1)) {
    return {
      ok: true,
      codecId: MACHINE_LIVE_STREAM_BASELINE_CODEC_V1,
      ...(input.preferredCodec ? { fallbackReason: 'preferred_codec_unavailable' as const } : { fallbackReason: 'baseline_selected' as const }),
    };
  }

  const commonCodec = firstCommonCodec(sourceCodecs, viewerCodecs);
  return commonCodec ? { ok: true, codecId: commonCodec } : { ok: false, reasonCode: 'no_common_codec' };
}

export function validateMachineLiveStreamPayloadCodecV1(input: Readonly<{
  negotiatedCodecId: MachineLiveStreamCodecIdV1;
  payload: unknown;
}>): Readonly<{ ok: true } | { ok: false; reasonCode: 'invalid_payload' | 'codec_not_negotiated' }> {
  const parsed = MachineLiveStreamPayloadV2Schema.safeParse(input.payload);
  if (!parsed.success) return { ok: false, reasonCode: 'invalid_payload' };
  return parsed.data.codecId === input.negotiatedCodecId
    ? { ok: true }
    : { ok: false, reasonCode: 'codec_not_negotiated' };
}
