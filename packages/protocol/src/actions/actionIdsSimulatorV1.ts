import type { SimulatorDeviceOperationKindV1 } from '../devices/simulator/operationsV1.js';

/** One operation-to-Action projection for device commands, consumed by every surface. */
export const SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1 = {
  boot: 'devices.simulator.device.boot',
  power_off: 'devices.simulator.device.powerOff',
  app_launch: 'devices.simulator.app.launch',
  app_terminate: 'devices.simulator.app.terminate',
  open_url: 'devices.simulator.url.open',
  screenshot: 'devices.simulator.screenshot.capture',
  appearance_set: 'devices.simulator.appearance.set',
  text_size_set: 'devices.simulator.textSize.set',
  location_set: 'devices.simulator.location.set',
  location_clear: 'devices.simulator.location.clear',
  permission_set: 'devices.simulator.permission.set',
  push: 'devices.simulator.push.send',
  hardware: 'devices.simulator.hardware.button',
  rotate: 'devices.simulator.rotation.set',
} as const satisfies Record<SimulatorDeviceOperationKindV1, string>;

export const SIMULATOR_SCREENSHOT_LEGACY_ACTION_ID_V1 = 'devices.simulator.stream.snapshot' as const;
export type SimulatorDeviceOperationRuntimeActionIdV1 =
  typeof SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1[SimulatorDeviceOperationKindV1]
  | typeof SIMULATOR_SCREENSHOT_LEGACY_ACTION_ID_V1;

const DEVICE_OPERATION_KIND_BY_ACTION_ID_V1 = new Map<string, SimulatorDeviceOperationKindV1>([
  ...Object.entries(SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1).map(([operation, actionId]) =>
    [actionId, operation as SimulatorDeviceOperationKindV1] as const),
  [SIMULATOR_SCREENSHOT_LEGACY_ACTION_ID_V1, 'screenshot'],
]);

export function simulatorDeviceOperationKindForActionIdV1(actionId: string): SimulatorDeviceOperationKindV1 | null {
  return DEVICE_OPERATION_KIND_BY_ACTION_ID_V1.get(actionId) ?? null;
}

export function isSimulatorDeviceOperationRuntimeActionIdV1(actionId: string): actionId is SimulatorDeviceOperationRuntimeActionIdV1 {
  return DEVICE_OPERATION_KIND_BY_ACTION_ID_V1.has(actionId);
}

export const SIMULATOR_INPUT_ACTION_IDS_V1 = [
  'devices.simulator.input.tap', 'devices.simulator.input.swipe', 'devices.simulator.input.text',
  'devices.simulator.input.key', 'devices.simulator.input.button', 'devices.simulator.input.orientation',
  'devices.simulator.input.pinch', 'devices.simulator.input.rotate',
] as const;

export const SIMULATOR_MUTATING_DEVICE_ACTION_IDS_V1 = Object.values(SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1)
  .filter((id) => id !== SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1.screenshot);

export const SIMULATOR_STATICALLY_BACKED_ACTION_IDS_V1 = [
  'devices.simulator.list', 'devices.simulator.lease.acquire', 'devices.simulator.lease.renew',
  'devices.simulator.lease.release', 'devices.simulator.input.tap', 'devices.simulator.input.swipe',
  'devices.simulator.input.text', 'devices.simulator.input.key', 'devices.simulator.input.button',
  'devices.simulator.sideband.request',
] as const;
export const SIMULATOR_STATICALLY_UNBACKED_ACTION_IDS_V1 = ['devices.simulator.input.orientation'] as const;
export const SIMULATOR_RESOURCE_GATED_ACTION_IDS_V1 = [
  'devices.simulator.input.pinch', 'devices.simulator.input.rotate', 'devices.simulator.stream.keyframe',
  'devices.simulator.stream.quality.set', 'devices.simulator.stream.fps.set', 'devices.simulator.stream.scale.set',
  ...Object.values(SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1), SIMULATOR_SCREENSHOT_LEGACY_ACTION_ID_V1,
] as const;
