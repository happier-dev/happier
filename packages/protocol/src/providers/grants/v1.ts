import { z } from 'zod';

import { ProviderConnectionIdSchema, ProviderMachineIdSchema } from '../ids.js';
import { ProviderProbeRequestFingerprintV1Schema } from '../fingerprints.js';

const FingerprintSchema = z.string().trim().min(1).max(256);

export const ProviderMachineGrantV1Schema = z.object({
  v: z.literal(1),
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
  endpointSetFingerprint: FingerprintSchema,
  connectionSecurityFingerprint: FingerprintSchema,
  confirmedAt: z.number().finite().nonnegative(),
}).strict();
export type ProviderMachineGrantV1 = z.infer<typeof ProviderMachineGrantV1Schema>;

export const ProviderAccountGrantV1Schema = z.object({
  v: z.literal(1),
  connectionId: ProviderConnectionIdSchema,
  connectionSecurityFingerprint: FingerprintSchema,
  confirmedAt: z.number().finite().nonnegative(),
}).strict();
export type ProviderAccountGrantV1 = z.infer<typeof ProviderAccountGrantV1Schema>;

export const ProviderProbeAuthorizationV1Schema = z.object({
  v: z.literal(1),
  id: z.string().trim().min(16).max(256),
  machineId: ProviderMachineIdSchema,
  endpointSetFingerprint: FingerprintSchema,
  credentialDestinationFingerprint: FingerprintSchema,
  probeRequestFingerprint: ProviderProbeRequestFingerprintV1Schema,
  selectedSecretBindingId: z.string().trim().min(1).max(256).nullable(),
  selectedSecretRecordFingerprint: FingerprintSchema.nullable(),
  use: z.literal('probe'),
  expiresAt: z.number().finite().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if ((value.selectedSecretBindingId === null) !== (value.selectedSecretRecordFingerprint === null)) {
    ctx.addIssue({ code: 'custom', path: ['selectedSecretRecordFingerprint'], message: 'Secret id and record fingerprint must be present together' });
  }
});
export type ProviderProbeAuthorizationV1 = z.infer<typeof ProviderProbeAuthorizationV1Schema>;

export const ProviderBindingAuthorizationTicketV1Schema = z.object({
  connectionId: ProviderConnectionIdSchema,
  machineId: ProviderMachineIdSchema,
  connectionSecurityFingerprint: FingerprintSchema,
  bindingSecurityFingerprint: FingerprintSchema,
  grantFingerprint: FingerprintSchema,
  selectedSecretBindingId: z.string().trim().min(1).max(256).nullable(),
  selectedSecretRecordFingerprint: FingerprintSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.selectedSecretBindingId === null) !== (value.selectedSecretRecordFingerprint === null)) {
    ctx.addIssue({ code: 'custom', path: ['selectedSecretRecordFingerprint'], message: 'Secret id and record fingerprint must be present together' });
  }
});
export type ProviderBindingAuthorizationTicketV1 = z.infer<typeof ProviderBindingAuthorizationTicketV1Schema>;
