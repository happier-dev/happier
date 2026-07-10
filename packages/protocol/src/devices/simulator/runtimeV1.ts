import { z } from 'zod';

import {
  MachineLiveStreamControlLeaseV1Schema,
  MachineLiveStreamControlSidebandV1Schema,
  MachineLiveStreamRouteKindV1Schema,
} from '../../machines/peer/mediation/stream/index.js';
import { SimulatorDeviceResourceV1Schema } from './v1.js';
import { SimulatorSidebandKindV1Schema, SimulatorSidebandMessageV1Schema } from './sidebandV1.js';

const NonNegativeIntSchema = z.number().int().nonnegative();
const NonEmptyStringSchema = z.string().trim().min(1).max(256);

export const SimulatorPreviewSnapshotV1Schema = z
  .object({
    v: z.literal(1),
    machineId: NonEmptyStringSchema,
    generatedAt: NonNegativeIntSchema,
    refreshState: z.enum(['idle', 'refreshing', 'error']),
    resources: z.array(SimulatorDeviceResourceV1Schema),
    diagnostics: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .strict();
export type SimulatorPreviewSnapshotV1 = z.infer<typeof SimulatorPreviewSnapshotV1Schema>;

export const SimulatorPreviewActionTypeV1Schema = z.enum([
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
]);
export type SimulatorPreviewActionTypeV1 = z.infer<typeof SimulatorPreviewActionTypeV1Schema>;

const BaseSimulatorActionWithSimulatorV1Schema = z.object({
  simulatorId: NonEmptyStringSchema,
});

function controlMatchesRequestedStreamAndSource(input: Readonly<{
  streamId: string;
  sourceId: string;
  control: { streamId: string; sourceId: string };
}>): boolean {
  return input.streamId === input.control.streamId && input.sourceId === input.control.sourceId;
}

export const SimulatorPreviewActionV1Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('simulator.devices.list') }).strict(),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.stream.open'),
    sourceId: NonEmptyStringSchema,
  }).strict(),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.stream.close'),
    streamId: NonEmptyStringSchema,
  }).strict(),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.lease.acquire'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    viewerId: NonEmptyStringSchema,
  }).strict(),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.lease.release'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    leaseId: NonEmptyStringSchema,
  }).strict(),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.lease.renew'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    leaseId: NonEmptyStringSchema,
    viewerId: NonEmptyStringSchema,
  }).strict(),
  z.object({
    type: z.literal('simulator.control.send'),
    control: MachineLiveStreamControlSidebandV1Schema,
  }).strict(),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.sideband.request'),
    kind: SimulatorSidebandKindV1Schema,
  }).strict(),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.quality.set'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    control: MachineLiveStreamControlSidebandV1Schema.refine(
      (control) => control.kind === 'set_quality',
      { message: 'Simulator quality actions must carry set_quality controls.' },
    ),
  }).strict().refine(controlMatchesRequestedStreamAndSource, {
    message: 'Simulator quality controls must match the requested stream and source.',
  }),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.keyframe.request'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    control: MachineLiveStreamControlSidebandV1Schema.refine(
      (control) => control.kind === 'request_keyframe',
      { message: 'Simulator keyframe actions must carry request_keyframe controls.' },
    ),
  }).strict().refine(controlMatchesRequestedStreamAndSource, {
    message: 'Simulator keyframe controls must match the requested stream and source.',
  }),
  BaseSimulatorActionWithSimulatorV1Schema.extend({
    type: z.literal('simulator.snapshot.request'),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    eventId: NonEmptyStringSchema,
  }).strict(),
]);
export type SimulatorPreviewActionV1 = z.infer<typeof SimulatorPreviewActionV1Schema>;

const BaseSimulatorPreviewActionResultV1Schema = z.object({
  v: z.literal(1),
  eventType: SimulatorPreviewActionTypeV1Schema,
  diagnostics: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const SimulatorPreviewStreamBindingV1Schema = z
  .object({
    v: z.literal(1),
    streamId: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    streamFamily: NonEmptyStringSchema,
    routeKind: MachineLiveStreamRouteKindV1Schema,
    sourceMachineId: NonEmptyStringSchema,
    targetMachineId: NonEmptyStringSchema,
    expiresAtMs: NonNegativeIntSchema.optional(),
  })
  .strict();
export type SimulatorPreviewStreamBindingV1 = z.infer<typeof SimulatorPreviewStreamBindingV1Schema>;

export const SimulatorPreviewActionResultV1Schema = z.discriminatedUnion('status', [
  BaseSimulatorPreviewActionResultV1Schema.extend({
    status: z.literal('accepted'),
    lease: MachineLiveStreamControlLeaseV1Schema.optional(),
    sideband: SimulatorSidebandMessageV1Schema.optional(),
    stream: SimulatorPreviewStreamBindingV1Schema.optional(),
  }).strict(),
  BaseSimulatorPreviewActionResultV1Schema.extend({
    status: z.literal('rejected'),
    reasonCode: NonEmptyStringSchema,
  }).strict(),
  BaseSimulatorPreviewActionResultV1Schema.extend({
    status: z.literal('unavailable'),
    reasonCode: NonEmptyStringSchema,
  }).strict(),
]);
export type SimulatorPreviewActionResultV1 = z.infer<typeof SimulatorPreviewActionResultV1Schema>;

export const DaemonSimulatorPreviewSnapshotRequestV1Schema = z
  .object({
    machineId: NonEmptyStringSchema,
  })
  .strict();
export type DaemonSimulatorPreviewSnapshotRequestV1 = z.infer<
  typeof DaemonSimulatorPreviewSnapshotRequestV1Schema
>;

export const DaemonSimulatorPreviewSnapshotResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    snapshot: SimulatorPreviewSnapshotV1Schema,
  })
  .strict();
export type DaemonSimulatorPreviewSnapshotResponseV1 = z.infer<
  typeof DaemonSimulatorPreviewSnapshotResponseV1Schema
>;

export const DaemonSimulatorPreviewActionRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: NonEmptyStringSchema,
    event: SimulatorPreviewActionV1Schema,
  })
  .strict();
export type DaemonSimulatorPreviewActionRequestV1 = z.infer<
  typeof DaemonSimulatorPreviewActionRequestV1Schema
>;

export const DaemonSimulatorPreviewActionResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: SimulatorPreviewActionResultV1Schema,
  })
  .strict();
export type DaemonSimulatorPreviewActionResponseV1 = z.infer<
  typeof DaemonSimulatorPreviewActionResponseV1Schema
>;
