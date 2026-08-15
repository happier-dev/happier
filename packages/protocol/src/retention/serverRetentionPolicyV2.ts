import { z } from 'zod';

export const ServerRetentionDomainPolicyV2Schema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('keep_forever') }),
  z.strictObject({ mode: z.literal('delete_older_than'), days: z.number().int().min(1) }),
  z.strictObject({ mode: z.literal('delete_inactive'), inactivityDays: z.number().int().min(1) }),
]);

export const ServerRetentionDomainV2Schema = z.strictObject({
  id: z.string().trim().min(1),
  policy: ServerRetentionDomainPolicyV2Schema,
});

export const ServerRetentionPolicyV2Schema = z.strictObject({
  version: z.literal(2),
  enabled: z.boolean(),
  complete: z.literal(true),
  domains: z.array(ServerRetentionDomainV2Schema),
});

export type ServerRetentionDomainPolicyV2 = z.infer<typeof ServerRetentionDomainPolicyV2Schema>;
export type ServerRetentionDomainV2 = z.infer<typeof ServerRetentionDomainV2Schema>;
export type ServerRetentionPolicyV2 = z.infer<typeof ServerRetentionPolicyV2Schema>;
