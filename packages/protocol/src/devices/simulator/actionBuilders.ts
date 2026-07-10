import type { MachineLiveStreamControlSidebandV1 } from '../../machines/peer/mediation/stream/index.js';
import type { SimulatorSidebandKindV1 } from './sidebandV1.js';
import type { SimulatorPreviewActionV1 } from './runtimeV1.js';

export const BACKED_SIMULATOR_SIDEBAND_KINDS_V1 = [
  'capture_health',
] as const satisfies readonly SimulatorSidebandKindV1[];

const BACKED_SIMULATOR_SIDEBAND_KIND_SET_V1 = new Set<SimulatorSidebandKindV1>(
  BACKED_SIMULATOR_SIDEBAND_KINDS_V1,
);

type EventIdFactory = (kind: string) => string;

type SimulatorSourceInput = Readonly<{
  simulatorId: string;
  sourceId: string;
}>;

type SimulatorStreamInput = Readonly<{
  simulatorId: string;
  streamId: string;
  sourceId: string;
}>;

type SimulatorStreamControlInput<TControl extends MachineLiveStreamControlSidebandV1> =
  SimulatorStreamInput & Readonly<{ control: TControl }>;

export function isBackedSimulatorSidebandKindV1(
  kind: unknown,
): kind is typeof BACKED_SIMULATOR_SIDEBAND_KINDS_V1[number] {
  return typeof kind === 'string' && BACKED_SIMULATOR_SIDEBAND_KIND_SET_V1.has(kind as SimulatorSidebandKindV1);
}

export function normalizeBackedSimulatorSidebandKindsV1(
  kinds: readonly unknown[],
): SimulatorSidebandKindV1[] {
  const normalized: SimulatorSidebandKindV1[] = [];
  for (const kind of kinds) {
    if (!isBackedSimulatorSidebandKindV1(kind) || normalized.includes(kind)) continue;
    normalized.push(kind);
  }
  return normalized;
}

export function createSimulatorPreviewListDevicesEventV1(): Extract<
  SimulatorPreviewActionV1,
  { type: 'simulator.devices.list' }
> {
  return { type: 'simulator.devices.list' };
}

export function createSimulatorPreviewOpenStreamEventV1(
  input: SimulatorSourceInput,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.stream.open' }> {
  return {
    type: 'simulator.stream.open',
    simulatorId: input.simulatorId,
    sourceId: input.sourceId,
  };
}

export function createSimulatorPreviewCloseStreamEventV1(
  input: Readonly<{ simulatorId: string; streamId: string }>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.stream.close' }> {
  return {
    type: 'simulator.stream.close',
    simulatorId: input.simulatorId,
    streamId: input.streamId,
  };
}

export function createSimulatorPreviewAcquireLeaseEventV1(
  input: SimulatorStreamInput & Readonly<{ viewerId: string }>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.lease.acquire' }> {
  return {
    type: 'simulator.lease.acquire',
    simulatorId: input.simulatorId,
    streamId: input.streamId,
    sourceId: input.sourceId,
    viewerId: input.viewerId,
  };
}

export function createSimulatorPreviewReleaseLeaseEventV1(
  input: SimulatorStreamInput & Readonly<{ leaseId: string }>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.lease.release' }> {
  return {
    type: 'simulator.lease.release',
    simulatorId: input.simulatorId,
    streamId: input.streamId,
    sourceId: input.sourceId,
    leaseId: input.leaseId,
  };
}

export function createSimulatorPreviewRenewLeaseEventV1(
  input: SimulatorStreamInput & Readonly<{ leaseId: string; viewerId: string }>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.lease.renew' }> {
  return {
    type: 'simulator.lease.renew',
    simulatorId: input.simulatorId,
    streamId: input.streamId,
    sourceId: input.sourceId,
    leaseId: input.leaseId,
    viewerId: input.viewerId,
  };
}

export function createSimulatorPreviewSendControlEventV1(
  input: Readonly<{ control: MachineLiveStreamControlSidebandV1 }>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.control.send' }> {
  return {
    type: 'simulator.control.send',
    control: input.control,
  };
}

export function createSimulatorPreviewSidebandRequestEventV1(
  input: Readonly<{ simulatorId: string; kind: SimulatorSidebandKindV1 }>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.sideband.request' }> {
  return {
    type: 'simulator.sideband.request',
    simulatorId: input.simulatorId,
    kind: input.kind,
  };
}

export function createSimulatorPreviewSetQualityEventV1(
  input: SimulatorStreamControlInput<Extract<MachineLiveStreamControlSidebandV1, { kind: 'set_quality' }>>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.quality.set' }> {
  return {
    type: 'simulator.quality.set',
    simulatorId: input.simulatorId,
    streamId: input.streamId,
    sourceId: input.sourceId,
    control: input.control,
  };
}

export function createSimulatorPreviewRequestKeyframeEventV1(
  input: SimulatorStreamControlInput<Extract<MachineLiveStreamControlSidebandV1, { kind: 'request_keyframe' }>>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.keyframe.request' }> {
  return {
    type: 'simulator.keyframe.request',
    simulatorId: input.simulatorId,
    streamId: input.streamId,
    sourceId: input.sourceId,
    control: input.control,
  };
}

export function createSimulatorPreviewSnapshotRequestEventV1(
  input: SimulatorStreamInput & Readonly<{ createEventId: EventIdFactory }>,
): Extract<SimulatorPreviewActionV1, { type: 'simulator.snapshot.request' }> {
  return {
    type: 'simulator.snapshot.request',
    simulatorId: input.simulatorId,
    streamId: input.streamId,
    sourceId: input.sourceId,
    eventId: input.createEventId('snapshot'),
  };
}
