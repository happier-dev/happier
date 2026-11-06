import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ProviderConnectionIdSchema, ProviderMachineIdSchema } from '../ids.js';

const FingerprintSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

export const ProviderMachineGrantV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
  endpointSetFingerprint: FingerprintSchema,
  connectionSecurityFingerprint: FingerprintSchema,
  confirmedAt: z.number().check(z.nonnegative()),
}));
export type ProviderMachineGrantV1 = z.infer<typeof ProviderMachineGrantV1Schema>;

export const ProviderAccountGrantV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  connectionId: ProviderConnectionIdSchema,
  connectionSecurityFingerprint: FingerprintSchema,
  confirmedAt: z.number().check(z.nonnegative()),
}));
export type ProviderAccountGrantV1 = z.infer<typeof ProviderAccountGrantV1Schema>;

export const ProviderBindingAuthorizationTicketV1Schema = lazyZodSchema(() => z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  connectionRevision: z.number().check(z.int(), z.nonnegative()),
  machineId: ProviderMachineIdSchema,
  connectionSecurityFingerprint: FingerprintSchema,
  bindingSecurityFingerprint: FingerprintSchema,
  grantFingerprint: FingerprintSchema,
  selectedSecretBindingId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  selectedSecretRecordFingerprint: z.nullable(FingerprintSchema),
}).check(z.superRefine((value, ctx) => {
  if ((value.selectedSecretBindingId === null) !== (value.selectedSecretRecordFingerprint === null)) {
    ctx.addIssue({ code: 'custom', path: ['selectedSecretRecordFingerprint'], message: 'Secret id and record fingerprint must be present together' });
  }
})));
export type ProviderBindingAuthorizationTicketV1 = z.infer<typeof ProviderBindingAuthorizationTicketV1Schema>;

/** Opaque currentness comparison; the full authorization ticket stays private. */
export function projectProviderBindingAuthorizationTicketReferenceV1(ticket: ProviderBindingAuthorizationTicketV1): string {
  const current = ProviderBindingAuthorizationTicketV1Schema.parse(ticket);
  return computeCanonicalDomainSeparatedDigest('happier.provider-binding-authorization-ticket.v1', [
    current.connectionId, String(current.connectionRevision), current.machineId,
    current.connectionSecurityFingerprint, current.bindingSecurityFingerprint, current.grantFingerprint,
    JSON.stringify([current.selectedSecretBindingId, current.selectedSecretRecordFingerprint]),
  ]);
}
