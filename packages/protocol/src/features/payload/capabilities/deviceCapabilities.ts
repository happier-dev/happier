import { z } from 'zod';

import {
  normalizeSimulatorDeviceResourceVisibleCapabilitiesV1,
  normalizeBackedSimulatorSidebandKindsV1,
  SimulatorDeviceResourceV1Schema,
  SimulatorPlatformV1Schema,
} from '../../../devices/simulator/index.js';

const BackedSimulatorSidebandKindsV1Schema = z
  .array(z.unknown())
  .optional()
  .default([])
  .transform((kinds) => normalizeBackedSimulatorSidebandKindsV1(kinds));

const VisibleSimulatorDeviceResourceV1Schema = SimulatorDeviceResourceV1Schema.transform(
  (resource) => normalizeSimulatorDeviceResourceVisibleCapabilitiesV1(resource),
);

export const DeviceSimulatorPreviewCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    supportedPlatforms: z.array(SimulatorPlatformV1Schema).optional().default([]),
    availableDevices: z.array(VisibleSimulatorDeviceResourceV1Schema).optional().default([]),
    captureSupported: z.boolean().optional().default(false),
    inputSupported: z.boolean().optional().default(false),
    sidebandKinds: BackedSimulatorSidebandKindsV1Schema,
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();

export type DeviceSimulatorPreviewCapabilities = z.infer<typeof DeviceSimulatorPreviewCapabilitiesSchema>;

export const DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES: DeviceSimulatorPreviewCapabilities = {
  enabled: false,
  available: false,
  supportedPlatforms: [],
  availableDevices: [],
  captureSupported: false,
  inputSupported: false,
  sidebandKinds: [],
  disabledReasons: [],
};

export const DeviceCapabilitiesSchema = z
  .object({
    simulatorPreview: DeviceSimulatorPreviewCapabilitiesSchema.optional().default(
      DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
    ),
  })
  .strict();

export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>;

export const DEFAULT_DEVICE_CAPABILITIES: DeviceCapabilities = {
  simulatorPreview: DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
};
