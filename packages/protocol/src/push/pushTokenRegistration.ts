import { z } from '../zodRuntimePolicy.js';
import { DeviceRemoteAlertPolicyV1Schema } from '../account/settings/accountRemoteAlertPolicy.js';

export const PushTokenRegisterRequestSchema = z.object({
  token: z.string(),
  clientServerUrl: z.optional(z.string()),
  remoteAlerts: z.optional(z.strictObject({
    registrationId: z.string().check(z.minLength(1)),
    policy: z.nullable(DeviceRemoteAlertPolicyV1Schema),
  })),
});
export const PushTokenRegisterResponseSchema = z.object({ success: z.literal(true) });
export const PushTokenSchema = z.object({
  id: z.string(),
  token: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  clientServerUrl: z.optional(z.nullable(z.string())),
});
export const PushTokensResponseSchema = z.object({ tokens: z.array(PushTokenSchema) });
export const PushTokensRemoteAlertProjectionV2Schema = z.strictObject({
  v: z.literal(2),
  accountRemoteAlerts: z.strictObject({
    settingsVersion: z.number().check(z.int(), z.nonnegative()),
    status: z.enum(['disabled', 'current', 'stale']),
  }),
  tokens: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PushTokenSchema, { remoteAlerts: z.nullable(DeviceRemoteAlertPolicyV1Schema) }))),
});
export type PushTokensRemoteAlertProjectionV2 = z.infer<typeof PushTokensRemoteAlertProjectionV2Schema>;
