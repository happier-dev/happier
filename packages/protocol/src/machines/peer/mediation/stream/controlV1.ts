import { z } from 'zod';

const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();
const NormalizedCoordinateSchema = z.number().min(0).max(1);

export const MachineLiveStreamInputModeV1Schema = z.enum(['none', 'shared', 'exclusive']);

export const MachineLiveStreamControlLeaseV1Schema = z
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
  .passthrough();

const BaseSidebandControlSchema = z.object({
  v: z.literal(1),
  streamId: z.string().min(1),
  sourceId: z.string().min(1),
  eventId: z.string().min(1),
  leaseId: z.string().min(1).optional(),
});

export const MachineLiveStreamControlSidebandV1Schema = z.discriminatedUnion('kind', [
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
]);

export const MachineLiveStreamControlSourceV1Schema = z
  .object({
    sourceId: z.string().min(1),
    inputMode: MachineLiveStreamInputModeV1Schema,
  })
  .passthrough();

export type MachineLiveStreamInputModeV1 = z.infer<typeof MachineLiveStreamInputModeV1Schema>;
export type MachineLiveStreamControlLeaseV1 = z.infer<typeof MachineLiveStreamControlLeaseV1Schema>;
export type MachineLiveStreamControlSidebandV1 = z.infer<typeof MachineLiveStreamControlSidebandV1Schema>;
export type MachineLiveStreamControlSourceV1 = z.infer<typeof MachineLiveStreamControlSourceV1Schema>;

const INPUT_CONTROL_KINDS = new Set<MachineLiveStreamControlSidebandV1['kind']>([
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
]);

export function machineLiveStreamControlRequiresInputLeaseV1(
  control: MachineLiveStreamControlSidebandV1,
): boolean {
  return INPUT_CONTROL_KINDS.has(control.kind);
}

export function validateMachineLiveStreamControlLeaseV1(input: Readonly<{
  source: unknown;
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

  if (!machineLiveStreamControlRequiresInputLeaseV1(control.data)) return { ok: true };
  if (source.data.inputMode === 'none') return { ok: false, reasonCode: 'input_not_supported' };
  if (source.data.inputMode === 'shared') return { ok: true };
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
