import { z } from 'zod';

import { PEER_MEDIATION_RECEIPTS } from '../receipts.js';
import { MachineLiveStreamRouteKindV1Schema } from './v1.js';

const NonNegativeIntSchema = z.number().int().nonnegative();
const PositiveIntSchema = z.number().int().positive();
const UNSAFE_RECEIPT_KEYS = new Set([
  'payload',
  'payloadBase64',
  'imageData',
  'screenshot',
  'grantToken',
  'token',
  'nonceBase64Url',
  'endpointUrlWithToken',
]);

export const MachineLiveStreamReceiptV1Schema = z
  .object({
    v: z.literal(1),
    id: z.enum([
      PEER_MEDIATION_RECEIPTS.streamStarted,
      PEER_MEDIATION_RECEIPTS.streamPaused,
      PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
    ]),
    streamId: z.string().min(1),
    routeKind: MachineLiveStreamRouteKindV1Schema,
    flowKind: z.literal('live_stream'),
    reasonCode: z.string().min(1).optional(),
    bytesSent: NonNegativeIntSchema.optional(),
    bytesRelayed: NonNegativeIntSchema.optional(),
    bytesDropped: NonNegativeIntSchema.optional(),
    framesSent: NonNegativeIntSchema.optional(),
    framesDropped: NonNegativeIntSchema.optional(),
    durationMs: NonNegativeIntSchema.optional(),
    maxBitrateBps: PositiveIntSchema.optional(),
    maxFramesPerSecond: PositiveIntSchema.optional(),
    maxFrameBytes: PositiveIntSchema.optional(),
    maxDurationMs: PositiveIntSchema.optional(),
    maxTotalBytes: PositiveIntSchema.optional(),
  })
  .passthrough()
  .superRefine((receipt, ctx) => {
    for (const key of Object.keys(receipt)) {
      if (!UNSAFE_RECEIPT_KEYS.has(key)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'Live-stream receipts must not contain payload, grant, token, or nonce material',
      });
    }
  });
export type MachineLiveStreamReceiptV1 = z.infer<typeof MachineLiveStreamReceiptV1Schema>;
