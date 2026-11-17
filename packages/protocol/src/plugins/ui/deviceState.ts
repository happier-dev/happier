import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';

/** Deliberate plugin UI drafts only. This never writes Account settings or server records. */
export const PluginUiDeviceStateRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('read'), key: z.string().check(z.minLength(1)) }),
    z.strictObject({ operation: z.literal('write'), key: z.string().check(z.minLength(1)), value: PluginUiJsonValueV1Schema }),
    z.strictObject({ operation: z.literal('remove'), key: z.string().check(z.minLength(1)) }),
]));
export type PluginUiDeviceStateRequestV1 = z.infer<typeof PluginUiDeviceStateRequestV1Schema>;
export const PluginUiDeviceStateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ready'), value: z.nullable(PluginUiJsonValueV1Schema) }),
    z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['storage_unavailable', 'scope_unavailable']) }),
]));
export type PluginUiDeviceStateResultV1 = z.infer<typeof PluginUiDeviceStateResultV1Schema>;
