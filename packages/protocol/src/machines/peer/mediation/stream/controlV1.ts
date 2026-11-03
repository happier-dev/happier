import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { MachineLiveStreamCaptureSourceKindV1 } from './captureV1.js';
import { BrowserInputEventV1Schema } from '../../../../browser/input/v1.js';
import { MachineLiveStreamKeyModifierV1Schema } from './inputModifiersV1.js';

const PositiveIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));
const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const NormalizedCoordinateSchema = lazyZodSchema(() => z.number().check(z.minimum(0), z.maximum(1)));

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
  'browser_input',
] as const;
export const MachineLiveStreamInputControlKindV1Schema = lazyZodSchema(() => z.enum(MACHINE_LIVE_STREAM_INPUT_CONTROL_KINDS_V1));

export const MachineLiveStreamControlLeaseV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    leaseId: z.string().check(z.minLength(1)),
    streamId: z.string().check(z.minLength(1)),
    sourceId: z.string().check(z.minLength(1)),
    holderId: z.string().check(z.minLength(1)),
    mode: z.literal('exclusive'),
    acquiredAtMs: NonNegativeIntSchema,
    expiresAtMs: PositiveIntSchema,
  }));

const BaseSidebandControlSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  streamId: z.string().check(z.minLength(1)),
  sourceId: z.string().check(z.minLength(1)),
  eventId: z.string().check(z.minLength(1)),
  leaseId: z.optional(z.string().check(z.minLength(1))),
}));

export const MachineLiveStreamControlSidebandV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    ...BaseSidebandControlSchema.shape,
    kind: z.literal('browser_input'),
    controlEpoch: NonNegativeIntSchema,
    event: BrowserInputEventV1Schema,
  }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('tap'),
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('long_press'),
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
    durationMs: z.optional(PositiveIntSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('swipe'),
    fromX: NormalizedCoordinateSchema,
    fromY: NormalizedCoordinateSchema,
    toX: NormalizedCoordinateSchema,
    toY: NormalizedCoordinateSchema,
    durationMs: z.optional(PositiveIntSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('drag'),
    fromX: NormalizedCoordinateSchema,
    fromY: NormalizedCoordinateSchema,
    toX: NormalizedCoordinateSchema,
    toY: NormalizedCoordinateSchema,
    durationMs: z.optional(PositiveIntSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('pinch'),
    centerX: NormalizedCoordinateSchema,
    centerY: NormalizedCoordinateSchema,
    startDistance: z.number().check(z.positive()),
    endDistance: z.number().check(z.positive()),
    angle: z.optional(z.number()),
    durationMs: z.optional(PositiveIntSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('rotate'),
    centerX: NormalizedCoordinateSchema,
    centerY: NormalizedCoordinateSchema,
    radius: z.number().check(z.positive()),
    startAngle: z.number(),
    endAngle: z.number(),
    durationMs: z.optional(PositiveIntSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('keyboard_text'),
    text: z.string(),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('keyboard_key'),
    key: z.string().check(z.minLength(1)),
    modifiers: z.optional(z.array(MachineLiveStreamKeyModifierV1Schema)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('hardware_button'),
    button: z.string().check(z.minLength(1)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('orientation'),
    orientation: z.enum(['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight']),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('request_keyframe'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('set_quality'),
    maxBitrateBps: z.optional(PositiveIntSchema),
    maxFramesPerSecond: z.optional(PositiveIntSchema),
    maxWidth: z.optional(PositiveIntSchema),
    maxHeight: z.optional(PositiveIntSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('pause_capture'),
    reasonCode: z.optional(z.string().check(z.minLength(1))),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSidebandControlSchema, {
    kind: z.literal('resume_capture'),
  })),
]));

export const MachineLiveStreamControlSourceV1Schema = lazyZodSchema(() => z.looseObject({
    sourceId: z.string().check(z.minLength(1)),
    inputMode: MachineLiveStreamInputModeV1Schema,
  }));

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
