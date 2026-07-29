import { z } from 'zod';

function canonicalBoundedId(max: number) {
  return z.string().min(1).max(max)
    .refine((value) => value === value.trim(), 'Identifier must already be canonical without surrounding whitespace')
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Identifier must not contain control characters');
}

function canonicalRecordKeyId(max: number) {
  return canonicalBoundedId(max)
    .refine(
      (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
      'Identifier is reserved and cannot be used as a record key',
    );
}

export const ProviderConnectionIdSchema = canonicalRecordKeyId(256).brand<'ProviderConnectionId'>();
export type ProviderConnectionId = z.infer<typeof ProviderConnectionIdSchema>;

export const ProviderContributionKeySchema = canonicalRecordKeyId(512);
export type ProviderContributionKey = z.infer<typeof ProviderContributionKeySchema>;

export const ProviderLocalIdSchema = canonicalRecordKeyId(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const ProviderMachineIdSchema = canonicalRecordKeyId(256);

export const ProviderAgentTargetKeySchema = canonicalRecordKeyId(256);

export const ProviderModelIdSchema = canonicalBoundedId(512).refine(
  (value) => !/\s/u.test(value),
  'Model id must not contain whitespace',
);
