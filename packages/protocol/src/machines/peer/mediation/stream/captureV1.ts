import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from '../../../../zodRuntimePolicy.js';

import { MachineLiveStreamCodecIdV1Schema } from './codecsV1.js';
import { MachineLiveStreamInputModeV1Schema } from './controlV1.js';

const PositiveIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));
const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export const MachineLiveStreamCaptureSourceKindV1Schema = lazyZodSchema(() => z.enum([
  'screen',
  'browser',
  'simulator',
  'device',
  'plugin',
]));

export const MachineLiveStreamCaptureSidebandKindV1Schema = lazyZodSchema(() => z.enum([
  'accessibility_tree',
  'logs',
  'device_config',
  'app_metadata',
  'network_diagnostics',
  'route',
  'capture_health',
]));

export const MachineLiveStreamCaptureHealthV1Schema = lazyZodSchema(() => z.strictObject({
    status: z.enum(['available', 'starting', 'degraded', 'unavailable']),
    reasonCode: z.optional(z.string().check(z.minLength(1))),
    droppedFrames: z.optional(NonNegativeIntSchema),
    lastFrameAtMs: z.optional(NonNegativeIntSchema),
  }));

export const MachineLiveStreamCaptureSourceV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    sourceId: z.string().check(z.minLength(1)),
    sourceKind: MachineLiveStreamCaptureSourceKindV1Schema,
    displayName: z.optional(z.string().check(z.minLength(1))),
    supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).check(z.minLength(1)),
    maxWidth: z.optional(PositiveIntSchema),
    maxHeight: z.optional(PositiveIntSchema),
    maxFramesPerSecond: z.optional(PositiveIntSchema),
    inputMode: MachineLiveStreamInputModeV1Schema,
    sidebands: z._default(z.array(MachineLiveStreamCaptureSidebandKindV1Schema), []),
    health: MachineLiveStreamCaptureHealthV1Schema,
  }));

export const MachineLiveStreamCaptureUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    sourceId: z.optional(z.string().check(z.minLength(1))),
    reasonCode: z.string().check(z.minLength(1)),
    sourceKind: z.optional(MachineLiveStreamCaptureSourceKindV1Schema),
  }));

export type MachineLiveStreamCaptureSourceKindV1 = z.infer<
  typeof MachineLiveStreamCaptureSourceKindV1Schema
>;
export type MachineLiveStreamCaptureSidebandKindV1 = z.infer<
  typeof MachineLiveStreamCaptureSidebandKindV1Schema
>;
export type MachineLiveStreamCaptureHealthV1 = z.infer<typeof MachineLiveStreamCaptureHealthV1Schema>;
export type MachineLiveStreamCaptureSourceV1 = z.infer<typeof MachineLiveStreamCaptureSourceV1Schema>;
export type MachineLiveStreamCaptureUnavailableV1 = z.infer<
  typeof MachineLiveStreamCaptureUnavailableV1Schema
>;
