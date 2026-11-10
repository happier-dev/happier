import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  MachineLiveStreamControlLeaseV1Schema,
  MachineLiveStreamControlSidebandV1Schema,
} from '../../machines/peer/mediation/stream/controlV1.js';
import {
  MachineLiveStreamRouteKindV1Schema,
} from '../../machines/peer/mediation/stream/v1.js';
import { SimulatorDeviceResourceV1Schema } from './v1.js';
import { SimulatorSidebandKindV1Schema, SimulatorSidebandMessageV1Schema } from './sidebandV1.js';

const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const NonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

export const SimulatorPreviewSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    machineId: NonEmptyStringSchema,
    generatedAt: NonNegativeIntSchema,
    refreshState: z.enum(['idle', 'refreshing', 'error']),
    resources: z.array(SimulatorDeviceResourceV1Schema),
    diagnostics: z._default(z.array(z.record(z.string(), z.unknown())), []),
  }));
export type SimulatorPreviewSnapshotV1 = z.infer<typeof SimulatorPreviewSnapshotV1Schema>;

export const SimulatorPreviewActionTypeV1Schema = lazyZodSchema(() => z.enum([
  'simulator.devices.list',
  'simulator.stream.open',
  'simulator.stream.close',
  'simulator.lease.acquire',
  'simulator.lease.release',
  'simulator.lease.renew',
  'simulator.control.send',
  'simulator.sideband.request',
  'simulator.quality.set',
  'simulator.keyframe.request',
  'simulator.snapshot.request',
]));
export type SimulatorPreviewActionTypeV1 = z.infer<typeof SimulatorPreviewActionTypeV1Schema>;

const BaseSimulatorActionWithSimulatorV1Schema = lazyZodSchema(() => z.object({
  simulatorId: NonEmptyStringSchema,
}));

function controlMatchesRequestedStreamAndSource(input: Readonly<{
  streamId: string;
  sourceId: string;
  control: { streamId: string; sourceId: string };
}>): boolean {
  return input.streamId === input.control.streamId && input.sourceId === input.control.sourceId;
}

export const SimulatorPreviewActionV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('simulator.devices.list') }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.stream.open'),
    sourceId: NonEmptyStringSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.stream.close'),
    streamId: NonEmptyStringSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.lease.acquire'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    viewerId: NonEmptyStringSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.lease.release'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    leaseId: NonEmptyStringSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.lease.renew'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    leaseId: NonEmptyStringSchema,
    viewerId: NonEmptyStringSchema,
  })),
  z.strictObject({
    type: z.literal('simulator.control.send'),
    control: MachineLiveStreamControlSidebandV1Schema,
  }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.sideband.request'),
    kind: SimulatorSidebandKindV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.quality.set'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    control: MachineLiveStreamControlSidebandV1Schema.check(z.refine((control) => control.kind === 'set_quality', { message: 'Simulator quality actions must carry set_quality controls.' })),
  })).check(z.refine(controlMatchesRequestedStreamAndSource, {
    message: 'Simulator quality controls must match the requested stream and source.',
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.keyframe.request'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    control: MachineLiveStreamControlSidebandV1Schema.check(z.refine((control) => control.kind === 'request_keyframe', { message: 'Simulator keyframe actions must carry request_keyframe controls.' })),
  })).check(z.refine(controlMatchesRequestedStreamAndSource, {
    message: 'Simulator keyframe controls must match the requested stream and source.',
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorActionWithSimulatorV1Schema, {
    type: z.literal('simulator.snapshot.request'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    eventId: NonEmptyStringSchema,
  })),
]));
export type SimulatorPreviewActionV1 = z.infer<typeof SimulatorPreviewActionV1Schema>;

const BaseSimulatorPreviewActionResultV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  eventType: SimulatorPreviewActionTypeV1Schema,
  diagnostics: z._default(z.array(z.record(z.string(), z.unknown())), []),
}));

export const SimulatorPreviewStreamBindingV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    streamFamily: NonEmptyStringSchema,
    routeKind: MachineLiveStreamRouteKindV1Schema,
    sourceMachineId: NonEmptyStringSchema,
    targetMachineId: NonEmptyStringSchema,
    expiresAtMs: z.optional(NonNegativeIntSchema),
  }));
export type SimulatorPreviewStreamBindingV1 = z.infer<typeof SimulatorPreviewStreamBindingV1Schema>;

export const SimulatorPreviewActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorPreviewActionResultV1Schema, {
    status: z.literal('accepted'),
    lease: z.optional(MachineLiveStreamControlLeaseV1Schema),
    sideband: z.optional(SimulatorSidebandMessageV1Schema),
    stream: z.optional(SimulatorPreviewStreamBindingV1Schema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorPreviewActionResultV1Schema, {
    status: z.literal('rejected'),
    reasonCode: NonEmptyStringSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BaseSimulatorPreviewActionResultV1Schema, {
    status: z.literal('unavailable'),
    reasonCode: NonEmptyStringSchema,
  })),
]));
export type SimulatorPreviewActionResultV1 = z.infer<typeof SimulatorPreviewActionResultV1Schema>;

export const DaemonSimulatorPreviewSnapshotRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: NonEmptyStringSchema,
  }));
export type DaemonSimulatorPreviewSnapshotRequestV1 = z.infer<
  typeof DaemonSimulatorPreviewSnapshotRequestV1Schema
>;

export const DaemonSimulatorPreviewSnapshotResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    snapshot: SimulatorPreviewSnapshotV1Schema,
  }));
export type DaemonSimulatorPreviewSnapshotResponseV1 = z.infer<
  typeof DaemonSimulatorPreviewSnapshotResponseV1Schema
>;

export const DaemonSimulatorPreviewActionRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: NonEmptyStringSchema,
    event: SimulatorPreviewActionV1Schema,
  }));
export type DaemonSimulatorPreviewActionRequestV1 = z.infer<
  typeof DaemonSimulatorPreviewActionRequestV1Schema
>;

export const DaemonSimulatorPreviewActionResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: SimulatorPreviewActionResultV1Schema,
  }));
export type DaemonSimulatorPreviewActionResponseV1 = z.infer<
  typeof DaemonSimulatorPreviewActionResponseV1Schema
>;
