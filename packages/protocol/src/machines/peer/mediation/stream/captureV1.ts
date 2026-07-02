import { z } from 'zod';

import { MachineLiveStreamCodecIdV1Schema } from './codecsV1.js';
import { MachineLiveStreamInputModeV1Schema } from './controlV1.js';

const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();

export const MachineLiveStreamCaptureSourceKindV1Schema = z.enum([
  'screen',
  'browser',
  'simulator',
  'device',
  'plugin',
]);

export const MachineLiveStreamCaptureSidebandKindV1Schema = z.enum([
  'accessibility_tree',
  'logs',
  'device_config',
  'app_metadata',
  'network_diagnostics',
  'route',
  'capture_health',
]);

export const MachineLiveStreamCaptureHealthV1Schema = z
  .object({
    status: z.enum(['available', 'starting', 'degraded', 'unavailable']),
    reasonCode: z.string().min(1).optional(),
    droppedFrames: NonNegativeIntSchema.optional(),
    lastFrameAtMs: NonNegativeIntSchema.optional(),
  })
  .strict();

export const MachineLiveStreamCaptureSourceV1Schema = z
  .object({
    v: z.literal(1),
    sourceId: z.string().min(1),
    sourceKind: MachineLiveStreamCaptureSourceKindV1Schema,
    displayName: z.string().min(1).optional(),
    supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
    maxWidth: PositiveIntSchema.optional(),
    maxHeight: PositiveIntSchema.optional(),
    maxFramesPerSecond: PositiveIntSchema,
    inputMode: MachineLiveStreamInputModeV1Schema,
    sidebands: z.array(MachineLiveStreamCaptureSidebandKindV1Schema).default([]),
    health: MachineLiveStreamCaptureHealthV1Schema,
  })
  .passthrough();

export const MachineLiveStreamCaptureUnavailableV1Schema = z
  .object({
    v: z.literal(1),
    sourceId: z.string().min(1).optional(),
    reasonCode: z.string().min(1),
    sourceKind: MachineLiveStreamCaptureSourceKindV1Schema.optional(),
  })
  .strict();

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
