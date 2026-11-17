import { lazyActionSpecRecord } from '../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1, type RuntimeActionIdV1 } from '../actionIds.js';
import { SIMULATOR_DEVICE_OPERATION_SCHEMAS_V1, SimulatorDeviceOperationResultV1Schema, SimulatorDeviceScreenshotResultV1Schema, SimulatorAccessibilitySnapshotResultV1Schema, SimulatorAccessibilityPressResultV1Schema, type SimulatorDeviceOperationKindV1 } from '../../devices/simulator/operationsV1.js';
import {
  SimulatorPreviewActionResultV1Schema,
  SimulatorPreviewActionV1Schema,
  SimulatorPreviewSnapshotV1Schema,
  type SimulatorPreviewActionTypeV1,
} from '../../devices/simulator/runtimeV1.js';
import type { MachineLiveStreamControlSidebandV1 } from '../../machines/peer/mediation/stream/controlV1.js';
import type { RuntimeActionSpecFamily } from './common.js';

const RuntimeSimulatorQualityScalarInputSchema = lazyZodSchema(() => z.looseObject({
    simulatorId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    streamId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sourceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    value: z.number().check(z.positive()),
  }));

type DevicesSimulatorRuntimeActionId = Extract<RuntimeActionIdV1, `devices.simulator.${string}`>;

function simulatorEventSchema<const TType extends SimulatorPreviewActionTypeV1>(type: TType) {
  return z.intersection(SimulatorPreviewActionV1Schema, z.looseObject({ type: z.literal(type) }));
}

function simulatorEventWithControlKindSchema<
  const TType extends SimulatorPreviewActionTypeV1,
  const TKind extends MachineLiveStreamControlSidebandV1['kind'],
>(type: TType, kind: TKind) {
  return z.intersection(SimulatorPreviewActionV1Schema, z.looseObject({
      type: z.literal(type),
      control: z.looseObject({ kind: z.literal(kind) }),
    }));
}

type DeviceOperationInputSchemas = {
  [K in SimulatorDeviceOperationKindV1 as typeof SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1[K]]: typeof SIMULATOR_DEVICE_OPERATION_SCHEMAS_V1[K];
};
const DEVICE_OPERATION_INPUT_SCHEMAS = lazyActionSpecRecord(() => Object.fromEntries(
  Object.entries(SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1).map(([operation, actionId]) =>
    [actionId, SIMULATOR_DEVICE_OPERATION_SCHEMAS_V1[operation as SimulatorDeviceOperationKindV1]]),
) as DeviceOperationInputSchemas);
type DeviceOperationOutputSchemas = {
  [K in SimulatorDeviceOperationKindV1 as typeof SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1[K]]:
    K extends 'screenshot' ? typeof SimulatorDeviceScreenshotResultV1Schema
      : K extends 'accessibility_snapshot' ? typeof SimulatorAccessibilitySnapshotResultV1Schema
      : K extends 'accessibility_press' ? typeof SimulatorAccessibilityPressResultV1Schema
      : typeof SimulatorDeviceOperationResultV1Schema;
};
const DEVICE_OPERATION_OUTPUT_SCHEMAS = Object.fromEntries(
  Object.entries(SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1).map(([operation, actionId]) =>
    [actionId, operation === 'screenshot' ? SimulatorDeviceScreenshotResultV1Schema
      : operation === 'accessibility_snapshot' ? SimulatorAccessibilitySnapshotResultV1Schema
      : operation === 'accessibility_press' ? SimulatorAccessibilityPressResultV1Schema
      : SimulatorDeviceOperationResultV1Schema]),
) as DeviceOperationOutputSchemas;

const DEVICE_OPERATION_TITLES = {
  accessibility_snapshot: 'Inspect simulator accessibility', accessibility_press: 'Press simulator element by identifier',
  boot: 'Start simulator device', power_off: 'Power off simulator device',
  app_launch: 'Launch simulator app', app_terminate: 'Terminate simulator app',
  open_url: 'Open simulator URL', screenshot: 'Capture simulator screenshot',
  appearance_set: 'Set simulator appearance', text_size_set: 'Set simulator text size',
  location_set: 'Set simulator location', location_clear: 'Clear simulator location',
  permission_set: 'Set simulator app permission', push: 'Send simulator push notification',
  hardware: 'Press simulator hardware button', rotate: 'Rotate simulator device',
} satisfies Record<SimulatorDeviceOperationKindV1, string>;
const DEVICE_OPERATION_ACTION_TITLES = Object.fromEntries(
  Object.entries(SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1).map(([operation, actionId]) =>
    [actionId, DEVICE_OPERATION_TITLES[operation as SimulatorDeviceOperationKindV1]]),
);

export const SIMULATOR_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  ...DEVICE_OPERATION_ACTION_TITLES,
  'devices.simulator.list': 'List simulator devices',
  'devices.simulator.stream.keyframe': 'Request simulator stream keyframe',
  'devices.simulator.stream.snapshot': 'Capture simulator screenshot',
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

export const SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS = lazyActionSpecRecord(() => Object.freeze({
  ...DEVICE_OPERATION_INPUT_SCHEMAS,
  'devices.simulator.list': simulatorEventSchema('simulator.devices.list'),
  'devices.simulator.stream.keyframe': simulatorEventWithControlKindSchema(
    'simulator.keyframe.request',
    'request_keyframe',
  ),
  'devices.simulator.stream.snapshot': SIMULATOR_DEVICE_OPERATION_SCHEMAS_V1.screenshot,
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
} as const satisfies Readonly<Record<DevicesSimulatorRuntimeActionId, z.ZodMiniType>>));

export const SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS = Object.freeze({
  ...DEVICE_OPERATION_OUTPUT_SCHEMAS,
  'devices.simulator.list': SimulatorPreviewSnapshotV1Schema,
  'devices.simulator.stream.keyframe': SimulatorPreviewActionResultV1Schema,
  'devices.simulator.stream.snapshot': SimulatorDeviceScreenshotResultV1Schema,
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
} as const satisfies Readonly<Record<DevicesSimulatorRuntimeActionId, z.ZodMiniType>>);

export const SIMULATOR_RUNTIME_ACTION_DESCRIPTIONS: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  ...DEVICE_OPERATION_ACTION_TITLES,
  'devices.simulator.list': 'See the phone and tablet simulators available on a machine.',
  'devices.simulator.stream.keyframe': 'Ask the simulator preview for a fresh full picture when it looks broken.',
  'devices.simulator.stream.snapshot': 'Capture the simulator screen and return a Session image media reference.',
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
  'devices.simulator.sideband.request': 'Request capture health for the simulator preview. Other diagnostic kinds are unavailable.',
});

export const SIMULATOR_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: SIMULATOR_RUNTIME_ACTION_TITLES,
  descriptions: SIMULATOR_RUNTIME_ACTION_DESCRIPTIONS,
  inputSchemas: SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS,
  outputSchemas: SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS,
} satisfies RuntimeActionSpecFamily);
