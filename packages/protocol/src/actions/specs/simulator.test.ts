import { describe, expect, it } from 'vitest';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import { getActionSpec } from '../actionSpecs.js';

type SimulatorEventRuntimeActionId = Exclude<
  Extract<RuntimeActionIdV1, `devices.simulator.${string}`>,
  'devices.simulator.stream.fps.set' | 'devices.simulator.stream.scale.set'
>;

const listEvent = { type: 'simulator.devices.list' } as const;
const acquireLeaseEvent = {
  type: 'simulator.lease.acquire',
  simulatorId: 'simulator_1',
  streamId: 'stream_1',
  sourceId: 'source_1',
  viewerId: 'viewer_1',
} as const;
const renewLeaseEvent = {
  type: 'simulator.lease.renew',
  simulatorId: 'simulator_1',
  streamId: 'stream_1',
  sourceId: 'source_1',
  leaseId: 'lease_1',
  viewerId: 'viewer_1',
} as const;
const releaseLeaseEvent = {
  type: 'simulator.lease.release',
  simulatorId: 'simulator_1',
  streamId: 'stream_1',
  sourceId: 'source_1',
  leaseId: 'lease_1',
} as const;
const tapEvent = {
  type: 'simulator.control.send',
  control: {
    v: 1,
    kind: 'tap',
    streamId: 'stream_1',
    sourceId: 'source_1',
    eventId: 'tap_1',
    leaseId: 'lease_1',
    x: 0.25,
    y: 0.75,
  },
} as const;
const swipeEvent = {
  type: 'simulator.control.send',
  control: {
    v: 1,
    kind: 'swipe',
    streamId: 'stream_1',
    sourceId: 'source_1',
    eventId: 'swipe_1',
    leaseId: 'lease_1',
    fromX: 0.1,
    fromY: 0.2,
    toX: 0.8,
    toY: 0.9,
  },
} as const;

const eventCases = [
  {
    actionId: 'devices.simulator.list',
    input: listEvent,
    mismatchedInput: acquireLeaseEvent,
  },
  {
    actionId: 'devices.simulator.stream.keyframe',
    input: {
      type: 'simulator.keyframe.request',
      simulatorId: 'simulator_1',
      streamId: 'stream_1',
      sourceId: 'source_1',
      control: {
        v: 1,
        kind: 'request_keyframe',
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'keyframe_1',
      },
    },
    mismatchedInput: listEvent,
  },
  {
    actionId: 'devices.simulator.stream.snapshot',
    input: {
      type: 'simulator.snapshot.request',
      simulatorId: 'simulator_1',
      streamId: 'stream_1',
      sourceId: 'source_1',
      eventId: 'snapshot_1',
    },
    mismatchedInput: listEvent,
  },
  {
    actionId: 'devices.simulator.stream.quality.set',
    input: {
      type: 'simulator.quality.set',
      simulatorId: 'simulator_1',
      streamId: 'stream_1',
      sourceId: 'source_1',
      control: {
        v: 1,
        kind: 'set_quality',
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'quality_1',
        maxFramesPerSecond: 24,
      },
    },
    mismatchedInput: listEvent,
  },
  {
    actionId: 'devices.simulator.lease.acquire',
    input: acquireLeaseEvent,
    mismatchedInput: tapEvent,
  },
  {
    actionId: 'devices.simulator.lease.renew',
    input: renewLeaseEvent,
    mismatchedInput: acquireLeaseEvent,
  },
  {
    actionId: 'devices.simulator.lease.release',
    input: releaseLeaseEvent,
    mismatchedInput: acquireLeaseEvent,
  },
  {
    actionId: 'devices.simulator.input.tap',
    input: tapEvent,
    mismatchedInput: swipeEvent,
  },
  {
    actionId: 'devices.simulator.input.swipe',
    input: swipeEvent,
    mismatchedInput: tapEvent,
  },
  {
    actionId: 'devices.simulator.input.text',
    input: {
      type: 'simulator.control.send',
      control: {
        v: 1,
        kind: 'keyboard_text',
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'text_1',
        leaseId: 'lease_1',
        text: 'hello',
      },
    },
    mismatchedInput: tapEvent,
  },
  {
    actionId: 'devices.simulator.input.key',
    input: {
      type: 'simulator.control.send',
      control: {
        v: 1,
        kind: 'keyboard_key',
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'key_1',
        leaseId: 'lease_1',
        key: 'ENTER',
      },
    },
    mismatchedInput: tapEvent,
  },
  {
    actionId: 'devices.simulator.input.button',
    input: {
      type: 'simulator.control.send',
      control: {
        v: 1,
        kind: 'hardware_button',
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'button_1',
        leaseId: 'lease_1',
        button: 'HOME',
      },
    },
    mismatchedInput: tapEvent,
  },
  {
    actionId: 'devices.simulator.input.orientation',
    input: {
      type: 'simulator.control.send',
      control: {
        v: 1,
        kind: 'orientation',
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'orientation_1',
        leaseId: 'lease_1',
        orientation: 'landscapeLeft',
      },
    },
    mismatchedInput: tapEvent,
  },
  {
    actionId: 'devices.simulator.input.pinch',
    input: {
      type: 'simulator.control.send',
      control: {
        v: 1,
        kind: 'pinch',
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'pinch_1',
        leaseId: 'lease_1',
        centerX: 0.5,
        centerY: 0.5,
        startDistance: 0.2,
        endDistance: 0.6,
      },
    },
    mismatchedInput: tapEvent,
  },
  {
    actionId: 'devices.simulator.input.rotate',
    input: {
      type: 'simulator.control.send',
      control: {
        v: 1,
        kind: 'rotate',
        streamId: 'stream_1',
        sourceId: 'source_1',
        eventId: 'rotate_1',
        leaseId: 'lease_1',
        centerX: 0.5,
        centerY: 0.5,
        radius: 0.25,
        startAngle: 0,
        endAngle: 90,
      },
    },
    mismatchedInput: tapEvent,
  },
  {
    actionId: 'devices.simulator.sideband.request',
    input: {
      type: 'simulator.sideband.request',
      simulatorId: 'simulator_1',
      kind: 'capture_health',
    },
    mismatchedInput: tapEvent,
  },
] as const satisfies readonly Readonly<{
  actionId: SimulatorEventRuntimeActionId;
  input: unknown;
  mismatchedInput: unknown;
}>[];

describe('simulator runtime Action specs', () => {
  it.each(eventCases)('binds $actionId to its exact event leaf', ({ actionId, input, mismatchedInput }) => {
    const schema = getActionSpec(actionId).inputSchema;

    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse(mismatchedInput).success).toBe(false);
  });

  it.each([
    'devices.simulator.stream.fps.set',
    'devices.simulator.stream.scale.set',
  ] as const)('keeps %s on the scalar input contract', (actionId) => {
    const schema = getActionSpec(actionId).inputSchema;

    expect(schema.safeParse({
      simulatorId: 'simulator_1',
      streamId: 'stream_1',
      sourceId: 'source_1',
      value: 24,
    }).success).toBe(true);
    expect(schema.safeParse(listEvent).success).toBe(false);
  });
});
