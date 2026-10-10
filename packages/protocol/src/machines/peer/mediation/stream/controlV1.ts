import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod';
import type { MachineLiveStreamCaptureSourceKindV1 } from './captureV1.js';

const PositiveIntSchema = lazyZodSchema(() => z.number().int().positive());
const NonNegativeIntSchema = lazyZodSchema(() => z.number().int().nonnegative());
const NormalizedCoordinateSchema = lazyZodSchema(() => z.number().min(0).max(1));

export const MachineLiveStreamInputModeV1Schema = lazyZodSchema(() => z.enum(['none', 'shared', 'exclusive']));
export const MACHINE_LIVE_STREAM_INPUT_CONTROL_KINDS_V1 = [
  'tap',
  'long_press',
  'swipe',
  'drag',
  'pinch',
  'rotate',
  'keyboard_text',
  'keyboard_key',
  'hardware_button',
  'orientation',
] as const;
export const MachineLiveStreamInputControlKindV1Schema = lazyZodSchema(() => z.enum(MACHINE_LIVE_STREAM_INPUT_CONTROL_KINDS_V1));

export const MachineLiveStreamControlLeaseV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    leaseId: z.string().min(1),
    streamId: z.string().min(1),
    sourceId: z.string().min(1),
    holderId: z.string().min(1),
    mode: z.literal('exclusive'),
    acquiredAtMs: NonNegativeIntSchema,
    expiresAtMs: PositiveIntSchema,
  })
  .passthrough());

const BaseSidebandControlSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  streamId: z.string().min(1),
  sourceId: z.string().min(1),
  eventId: z.string().min(1),
  leaseId: z.string().min(1).optional(),
}));

export const MachineLiveStreamControlSidebandV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BaseSidebandControlSchema.extend({
    kind: z.literal('tap'),
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('long_press'),
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
    durationMs: PositiveIntSchema.optional(),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('swipe'),
    fromX: NormalizedCoordinateSchema,
    fromY: NormalizedCoordinateSchema,
    toX: NormalizedCoordinateSchema,
    toY: NormalizedCoordinateSchema,
    durationMs: PositiveIntSchema.optional(),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('drag'),
    fromX: NormalizedCoordinateSchema,
    fromY: NormalizedCoordinateSchema,
    toX: NormalizedCoordinateSchema,
    toY: NormalizedCoordinateSchema,
    durationMs: PositiveIntSchema.optional(),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('pinch'),
    centerX: NormalizedCoordinateSchema,
    centerY: NormalizedCoordinateSchema,
    startDistance: z.number().positive(),
    endDistance: z.number().positive(),
    angle: z.number().optional(),
    durationMs: PositiveIntSchema.optional(),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('rotate'),
    centerX: NormalizedCoordinateSchema,
    centerY: NormalizedCoordinateSchema,
    radius: z.number().positive(),
    startAngle: z.number(),
    endAngle: z.number(),
    durationMs: PositiveIntSchema.optional(),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('keyboard_text'),
    text: z.string(),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('keyboard_key'),
    key: z.string().min(1),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('hardware_button'),
    button: z.string().min(1),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('orientation'),
    orientation: z.enum(['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight']),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('request_keyframe'),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('set_quality'),
    maxBitrateBps: PositiveIntSchema.optional(),
    maxFramesPerSecond: PositiveIntSchema.optional(),
    maxWidth: PositiveIntSchema.optional(),
    maxHeight: PositiveIntSchema.optional(),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('pause_capture'),
    reasonCode: z.string().min(1).optional(),
  }).strict(),
  BaseSidebandControlSchema.extend({
    kind: z.literal('resume_capture'),
  }).strict(),
]));

export const MachineLiveStreamControlSourceV1Schema = lazyZodSchema(() => z
  .object({
    sourceId: z.string().min(1),
    inputMode: MachineLiveStreamInputModeV1Schema,
  })
  .passthrough());

export type MachineLiveStreamInputModeV1 = z.infer<typeof MachineLiveStreamInputModeV1Schema>;
export type MachineLiveStreamInputControlKindV1 = z.infer<typeof MachineLiveStreamInputControlKindV1Schema>;
export type MachineLiveStreamControlLeaseV1 = z.infer<typeof MachineLiveStreamControlLeaseV1Schema>;
export type MachineLiveStreamControlSidebandV1 = z.infer<typeof MachineLiveStreamControlSidebandV1Schema>;
export type MachineLiveStreamControlSourceV1 = z.infer<typeof MachineLiveStreamControlSourceV1Schema>;

const INPUT_CONTROL_KINDS = new Set<MachineLiveStreamControlSidebandV1['kind']>(MACHINE_LIVE_STREAM_INPUT_CONTROL_KINDS_V1);

export function machineLiveStreamControlRequiresInputLeaseV1(
  control: MachineLiveStreamControlSidebandV1,
): boolean {
  return INPUT_CONTROL_KINDS.has(control.kind);
}

export function validateMachineLiveStreamControlLeaseV1(input: Readonly<{
  source: unknown;
  /** Capture kind from the registered source, never from a viewer's control payload. */
  sourceKind?: MachineLiveStreamCaptureSourceKindV1;
  control: unknown;
  activeLease: unknown;
  nowMs: number;
}>): Readonly<
  | { ok: true }
  | {
    ok: false;
    reasonCode:
      | 'invalid_source'
      | 'invalid_control'
      | 'invalid_lease'
      | 'input_not_supported'
      | 'input_lease_required'
      | 'input_lease_expired'
      | 'input_lease_mismatch';
  }
> {
  const source = MachineLiveStreamControlSourceV1Schema.safeParse(input.source);
  if (!source.success) return { ok: false, reasonCode: 'invalid_source' };
  const control = MachineLiveStreamControlSidebandV1Schema.safeParse(input.control);
  if (!control.success) return { ok: false, reasonCode: 'invalid_control' };
  if (source.data.sourceId !== control.data.sourceId) return { ok: false, reasonCode: 'input_lease_mismatch' };

  if (!machineLiveStreamControlRequiresInputLeaseV1(control.data)) return { ok: true };
  if (source.data.inputMode === 'none') return { ok: false, reasonCode: 'input_not_supported' };
  // Browser input is arbitrated by the daemon automation/controller owner. Simulator/device
  // input retains its existing lease contract; source kind is supplied by the capture registry.
  if (input.sourceKind === 'browser') return { ok: true };
  if (!input.activeLease) return { ok: false, reasonCode: 'input_lease_required' };

  const lease = MachineLiveStreamControlLeaseV1Schema.safeParse(input.activeLease);
  if (!lease.success) return { ok: false, reasonCode: 'invalid_lease' };
  if (lease.data.expiresAtMs <= input.nowMs) return { ok: false, reasonCode: 'input_lease_expired' };
  if (
    lease.data.streamId !== control.data.streamId
    || lease.data.sourceId !== control.data.sourceId
    || lease.data.sourceId !== source.data.sourceId
    || control.data.leaseId !== lease.data.leaseId
  ) {
    return { ok: false, reasonCode: 'input_lease_mismatch' };
  }
  return { ok: true };
}
