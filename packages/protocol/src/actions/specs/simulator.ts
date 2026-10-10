import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import {
  SimulatorPreviewActionResultV1Schema,
  SimulatorPreviewActionV1Schema,
  SimulatorPreviewSnapshotV1Schema,
  type SimulatorPreviewActionTypeV1,
} from '../../devices/simulator/runtimeV1.js';
import type { MachineLiveStreamControlSidebandV1 } from '../../machines/peer/mediation/stream/controlV1.js';
import type { RuntimeActionSpecFamily } from './common.js';

const RuntimeSimulatorQualityScalarInputSchema = lazyZodSchema(() => z
  .object({
    simulatorId: z.string().trim().min(1).max(256),
    streamId: z.string().trim().min(1).max(256),
    sourceId: z.string().trim().min(1).max(256),
    value: z.number().positive(),
  })
  .passthrough());

type DevicesSimulatorRuntimeActionId = Extract<RuntimeActionIdV1, `devices.simulator.${string}`>;

function simulatorEventSchema<const TType extends SimulatorPreviewActionTypeV1>(type: TType) {
  return SimulatorPreviewActionV1Schema.and(
    z.object({ type: z.literal(type) }).passthrough(),
  );
}

function simulatorEventWithControlKindSchema<
  const TType extends SimulatorPreviewActionTypeV1,
  const TKind extends MachineLiveStreamControlSidebandV1['kind'],
>(type: TType, kind: TKind) {
  return SimulatorPreviewActionV1Schema.and(
    z.object({
      type: z.literal(type),
      control: z.object({ kind: z.literal(kind) }).passthrough(),
    }).passthrough(),
  );
}

export const SIMULATOR_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'devices.simulator.list': 'List simulator devices',
  'devices.simulator.stream.keyframe': 'Request simulator stream keyframe',
  'devices.simulator.stream.snapshot': 'Request simulator stream snapshot',
  'devices.simulator.stream.quality.set': 'Set simulator stream quality',
  'devices.simulator.stream.fps.set': 'Set simulator stream frame rate',
  'devices.simulator.stream.scale.set': 'Set simulator stream scale',
  'devices.simulator.lease.acquire': 'Acquire simulator control lease',
  'devices.simulator.lease.renew': 'Renew simulator control lease',
  'devices.simulator.lease.release': 'Release simulator control lease',
  'devices.simulator.input.tap': 'Tap simulator',
  'devices.simulator.input.swipe': 'Swipe simulator',
  'devices.simulator.input.text': 'Type simulator text',
  'devices.simulator.input.key': 'Press simulator key',
  'devices.simulator.input.button': 'Press simulator hardware button',
  'devices.simulator.input.orientation': 'Set simulator orientation',
  'devices.simulator.input.pinch': 'Pinch simulator',
  'devices.simulator.input.rotate': 'Rotate simulator',
  'devices.simulator.sideband.request': 'Request simulator sideband data',
});

export const SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS = Object.freeze({
  'devices.simulator.list': simulatorEventSchema('simulator.devices.list'),
  'devices.simulator.stream.keyframe': simulatorEventWithControlKindSchema(
    'simulator.keyframe.request',
    'request_keyframe',
  ),
  'devices.simulator.stream.snapshot': simulatorEventSchema('simulator.snapshot.request'),
  'devices.simulator.stream.quality.set': simulatorEventWithControlKindSchema(
    'simulator.quality.set',
    'set_quality',
  ),
  'devices.simulator.stream.fps.set': RuntimeSimulatorQualityScalarInputSchema,
  'devices.simulator.stream.scale.set': RuntimeSimulatorQualityScalarInputSchema,
  'devices.simulator.lease.acquire': simulatorEventSchema('simulator.lease.acquire'),
  'devices.simulator.lease.renew': simulatorEventSchema('simulator.lease.renew'),
  'devices.simulator.lease.release': simulatorEventSchema('simulator.lease.release'),
  'devices.simulator.input.tap': simulatorEventWithControlKindSchema('simulator.control.send', 'tap'),
  'devices.simulator.input.swipe': simulatorEventWithControlKindSchema('simulator.control.send', 'swipe'),
  'devices.simulator.input.text': simulatorEventWithControlKindSchema('simulator.control.send', 'keyboard_text'),
  'devices.simulator.input.key': simulatorEventWithControlKindSchema('simulator.control.send', 'keyboard_key'),
  'devices.simulator.input.button': simulatorEventWithControlKindSchema('simulator.control.send', 'hardware_button'),
  'devices.simulator.input.orientation': simulatorEventWithControlKindSchema('simulator.control.send', 'orientation'),
  'devices.simulator.input.pinch': simulatorEventWithControlKindSchema('simulator.control.send', 'pinch'),
  'devices.simulator.input.rotate': simulatorEventWithControlKindSchema('simulator.control.send', 'rotate'),
  'devices.simulator.sideband.request': simulatorEventSchema('simulator.sideband.request'),
} as const satisfies Readonly<Record<DevicesSimulatorRuntimeActionId, z.ZodTypeAny>>);

export const SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS = Object.freeze({
  'devices.simulator.list': SimulatorPreviewSnapshotV1Schema,
  'devices.simulator.stream.keyframe': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.stream.snapshot': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.stream.quality.set': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.stream.fps.set': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.stream.scale.set': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.lease.acquire': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.lease.renew': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.lease.release': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.input.tap': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.input.swipe': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.input.text': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.input.key': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.input.button': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.input.orientation': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.input.pinch': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.input.rotate': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.sideband.request': SimulatorPreviewActionResultV1Schema,
} as const satisfies Readonly<Record<DevicesSimulatorRuntimeActionId, z.ZodTypeAny>>);

export const SIMULATOR_RUNTIME_ACTION_DESCRIPTIONS: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'devices.simulator.list': 'See the phone and tablet simulators available on a machine.',
  'devices.simulator.stream.keyframe': 'Ask the simulator preview for a fresh full picture when it looks broken.',
  'devices.simulator.stream.snapshot': 'Take a still picture of what the simulator shows now.',
  'devices.simulator.stream.quality.set': 'Choose how sharp the simulator preview is. Sharper uses more data.',
  'devices.simulator.stream.fps.set': 'Choose how smooth the simulator preview is. Smoother uses more data.',
  'devices.simulator.stream.scale.set': 'Choose how large the simulator preview is sent.',
  'devices.simulator.lease.acquire': 'Take control of a simulator, so only one person or agent drives it at a time.',
  'devices.simulator.lease.renew': 'Keep control of a simulator for longer.',
  'devices.simulator.lease.release': 'Give up control of a simulator, so someone else can drive it.',
  'devices.simulator.input.tap': 'Tap a point on the simulator screen.',
  'devices.simulator.input.swipe': 'Swipe across the simulator screen.',
  'devices.simulator.input.text': 'Type text into the simulator.',
  'devices.simulator.input.key': 'Press a keyboard key in the simulator.',
  'devices.simulator.input.button': 'Press a device button on the simulator, such as Home or volume.',
  'devices.simulator.input.orientation': 'Turn the simulator to portrait or landscape.',
  'devices.simulator.input.pinch': 'Pinch on the simulator screen to zoom.',
  'devices.simulator.input.rotate': 'Rotate with two fingers on the simulator screen.',
  'devices.simulator.sideband.request': 'Ask the simulator for information beside the picture, such as its logs or what is on screen.',
});

export const SIMULATOR_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: SIMULATOR_RUNTIME_ACTION_TITLES,
  descriptions: SIMULATOR_RUNTIME_ACTION_DESCRIPTIONS,
  inputSchemas: SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS,
  outputSchemas: SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS,
} satisfies RuntimeActionSpecFamily);
