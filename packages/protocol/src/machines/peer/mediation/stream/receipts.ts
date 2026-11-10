import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from '../../../../zodRuntimePolicy.js';

import { PEER_MEDIATION_RECEIPTS } from '../receipts.js';
import { MachineLiveStreamRouteKindV1Schema } from './v1.js';

const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const PositiveIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));
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

export const MachineLiveStreamReceiptV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    id: z.enum([
      PEER_MEDIATION_RECEIPTS.streamStarted,
      PEER_MEDIATION_RECEIPTS.streamPaused,
      PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
    ]),
    streamId: z.string().check(z.minLength(1)),
    routeKind: MachineLiveStreamRouteKindV1Schema,
    flowKind: z.literal('live_stream'),
    reasonCode: z.optional(z.string().check(z.minLength(1))),
    terminal: z.optional(z.boolean()),
    terminalOutcome: z.optional(z.enum(['stopped', 'error'])),
    bytesSent: z.optional(NonNegativeIntSchema),
    bytesRelayed: z.optional(NonNegativeIntSchema),
    bytesDropped: z.optional(NonNegativeIntSchema),
    framesSent: z.optional(NonNegativeIntSchema),
    framesDropped: z.optional(NonNegativeIntSchema),
    durationMs: z.optional(NonNegativeIntSchema),
    maxBitrateBps: z.optional(PositiveIntSchema),
    maxFramesPerSecond: z.optional(PositiveIntSchema),
    maxFrameBytes: z.optional(PositiveIntSchema),
    maxDurationMs: z.optional(PositiveIntSchema),
    maxTotalBytes: z.optional(PositiveIntSchema),
  }).check(z.superRefine((receipt, ctx) => {
    for (const key of Object.keys(receipt)) {
      if (!UNSAFE_RECEIPT_KEYS.has(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: 'Live-stream receipts must not contain payload, grant, token, or nonce material',
      });
    }
  })));
export type MachineLiveStreamReceiptV1 = z.infer<typeof MachineLiveStreamReceiptV1Schema>;

export function isMachineLiveStreamTerminalReceiptV1(receipt: MachineLiveStreamReceiptV1): boolean {
  return receipt.terminal === true;
}
