import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { normalizeSimulatorDeviceResourceVisibleCapabilitiesV1, SimulatorDeviceResourceV1Schema, SimulatorPlatformV1Schema } from '../../../devices/simulator/v1.js';
import { normalizeBackedSimulatorSidebandKindsV1 } from '../../../devices/simulator/actionBuilders.js';

const BackedSimulatorSidebandKindsV1Schema = lazyZodSchema(() => z.pipe(z._default(z.optional(z
  .array(z.unknown())), []), z.transform((kinds) => normalizeBackedSimulatorSidebandKindsV1(kinds))));

const VisibleSimulatorDeviceResourceV1Schema = lazyZodSchema(() => z.pipe(SimulatorDeviceResourceV1Schema, z.transform((resource) => normalizeSimulatorDeviceResourceVisibleCapabilitiesV1(resource))));

export const DeviceSimulatorPreviewCapabilitiesSchema = lazyZodSchema(() => z.object({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    supportedPlatforms: z._default(z.optional(z.array(SimulatorPlatformV1Schema)), []),
    availableDevices: z._default(z.optional(z.array(VisibleSimulatorDeviceResourceV1Schema)), []),
    captureSupported: z._default(z.optional(z.boolean()), false),
    inputSupported: z._default(z.optional(z.boolean()), false),
    sidebandKinds: BackedSimulatorSidebandKindsV1Schema,
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));

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

export const DeviceCapabilitiesSchema = lazyZodSchema(() => z.object({
    simulatorPreview: z._default(z.optional(DeviceSimulatorPreviewCapabilitiesSchema), DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES),
  }));

export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>;

export const DEFAULT_DEVICE_CAPABILITIES: DeviceCapabilities = {
  simulatorPreview: DEFAULT_DEVICE_SIMULATOR_PREVIEW_CAPABILITIES,
};
