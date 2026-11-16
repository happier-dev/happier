import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionImageMediaReferenceV1Schema } from '../../sessions/media/imageReferenceV1.js';
import { SimulatorDeviceResourceV1Schema } from './v1.js';

const TextSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const PlatformSchema = lazyZodSchema(() => z.enum(['ios', 'android']));
const DeviceShape = { platform: PlatformSchema, deviceId: TextSchema };

export const SimulatorDeviceHardwareButtonV1Schema = lazyZodSchema(() => z.enum(['home', 'back', 'recents']));
export type SimulatorDeviceHardwareButtonV1 = z.infer<typeof SimulatorDeviceHardwareButtonV1Schema>;

/** The platform command boundary; screenshot destinations are Session media, never caller paths. */
export const SIMULATOR_DEVICE_OPERATION_SCHEMAS_V1 = {
  boot: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('boot') })),
  power_off: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('power_off') })),
  app_launch: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('app_launch'), appId: TextSchema })),
  app_terminate: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('app_terminate'), appId: TextSchema })),
  open_url: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('open_url'), url: TextSchema })),
  screenshot: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('screenshot'), sessionId: TextSchema })),
  appearance_set: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('appearance_set'), appearance: z.enum(['light', 'dark']) })),
  text_size_set: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('text_size_set'), size: TextSchema })),
  location_set: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('location_set'), latitude: z.number().check(z.minimum(-90), z.maximum(90)), longitude: z.number().check(z.minimum(-180), z.maximum(180)) })),
  location_clear: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('location_clear') })),
  permission_set: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('permission_set'), appId: TextSchema, permission: TextSchema, value: z.enum(['grant', 'revoke', 'reset']) })),
  push: lazyZodSchema(() => z.strictObject({ ...DeviceShape, platform: z.literal('ios'), operation: z.literal('push'), appId: TextSchema, payload: z.record(z.string(), z.unknown()) })),
  hardware: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('hardware'), button: SimulatorDeviceHardwareButtonV1Schema })),
  rotate: lazyZodSchema(() => z.strictObject({ ...DeviceShape, operation: z.literal('rotate'), orientation: z.enum(['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right']) })),
} as const;

export const SimulatorDeviceOperationV1Schema = lazyZodSchema(() => {
  const schemas = Object.values(SIMULATOR_DEVICE_OPERATION_SCHEMAS_V1);
  // The declaration above is a nonempty operation record; preserve that fact for Zod's tuple API.
  return z.discriminatedUnion('operation', schemas as [typeof schemas[number], ...typeof schemas[number][]]);
});
export type SimulatorDeviceOperationV1 = z.infer<typeof SimulatorDeviceOperationV1Schema>;
export type SimulatorDeviceOperationKindV1 = SimulatorDeviceOperationV1['operation'];
export const SimulatorDeviceOperationKindV1Schema = lazyZodSchema(() => z.enum(
  Object.keys(SIMULATOR_DEVICE_OPERATION_SCHEMAS_V1) as SimulatorDeviceOperationKindV1[],
));

const OperationFailureSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false), errorCode: TextSchema, step: TextSchema, exitCode: z.optional(z.number().check(z.int())),
}));

export const SimulatorDeviceOperationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), device: z.optional(SimulatorDeviceResourceV1Schema), media: z.optional(SessionImageMediaReferenceV1Schema) }),
  OperationFailureSchema,
]));
export type SimulatorDeviceOperationResultV1 = z.infer<typeof SimulatorDeviceOperationResultV1Schema>;

export const SimulatorDeviceScreenshotResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), media: SessionImageMediaReferenceV1Schema }),
  OperationFailureSchema,
]));
export type SimulatorDeviceScreenshotResultV1 = z.infer<typeof SimulatorDeviceScreenshotResultV1Schema>;
