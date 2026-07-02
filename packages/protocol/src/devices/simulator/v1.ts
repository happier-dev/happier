import { z } from 'zod';

import {
  MachineLiveStreamCodecIdV1Schema,
  MachineLiveStreamInputModeV1Schema,
} from '../../machines/peer/mediation/stream/index.js';

export const SimulatorPlatformV1Schema = z.enum(['ios', 'android']);

export const SimulatorCaptureCapabilitiesV1Schema = z
  .object({
    sourceId: z.string().min(1),
    supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
    inputMode: MachineLiveStreamInputModeV1Schema,
  })
  .strict();

export const SimulatorDeviceResourceV1Schema = z
  .object({
    v: z.literal(1),
    simulatorId: z.string().min(1),
    platform: SimulatorPlatformV1Schema,
    deviceId: z.string().min(1),
    displayName: z.string().min(1),
    appId: z.string().min(1).optional(),
    capture: SimulatorCaptureCapabilitiesV1Schema,
    unavailableReason: z.string().min(1).optional(),
  })
  .strict();

export type SimulatorPlatformV1 = z.infer<typeof SimulatorPlatformV1Schema>;
export type SimulatorCaptureCapabilitiesV1 = z.infer<typeof SimulatorCaptureCapabilitiesV1Schema>;
export type SimulatorDeviceResourceV1 = z.infer<typeof SimulatorDeviceResourceV1Schema>;
