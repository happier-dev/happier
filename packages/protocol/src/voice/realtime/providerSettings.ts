import { z } from 'zod';

import { SavedSecretSlotBindingsV1Schema } from '../../providers/settings/v1.js';
import {
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
} from '../../plugins/contributionIdentity.js';

const RESERVED_PROVIDER_IDS = new Set(['constructor', 'prototype']);

/**
 * Stable voice-conversation provider identity shared by persistence, registry,
 * and runtime projections. The open domain keeps existing underscore IDs valid
 * while excluding object-prototype keys at every record boundary.
 */
const LegacyVoiceProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .refine((providerId) => !RESERVED_PROVIDER_IDS.has(providerId), {
    message: 'Reserved provider identifier',
  });

const QualifiedExternalVoiceProviderIdSchema = z.string().min(3).max(256).refine((providerId) => {
  const separator = providerId.indexOf('/');
  if (separator <= 0 || separator === providerId.length - 1) return false;
  const identity = PluginContributionIdentityV1Schema.safeParse({
    pluginId: providerId.slice(0, separator),
    localId: providerId.slice(separator + 1),
  });
  return identity.success && buildQualifiedPluginContributionKey(identity.data) === providerId;
}, { message: 'External Voice provider ids must be canonical qualified Plugin contribution keys' });

export const VoiceProviderIdSchema = z.union([
  LegacyVoiceProviderIdSchema,
  QualifiedExternalVoiceProviderIdSchema,
]);

export type VoiceProviderId = z.infer<typeof VoiceProviderIdSchema>;

export const VoiceCredentialBindingV1Schema = z.object({
  providerId: VoiceProviderIdSchema,
  credentialBindings: SavedSecretSlotBindingsV1Schema,
  approvedRecipientContractDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
}).strict();

export type VoiceCredentialBindingV1 = Readonly<z.infer<typeof VoiceCredentialBindingV1Schema>>;

export type VoiceProviderSettingsJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly VoiceProviderSettingsJsonValueV1[]
  | Readonly<{ [key: string]: VoiceProviderSettingsJsonValueV1 }>;

function isVoiceProviderSettingsJsonValueV1(
  value: unknown,
  depth = 0,
  ancestors: Set<object> = new Set(),
): value is VoiceProviderSettingsJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 128 || ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isVoiceProviderSettingsJsonValueV1(entry, depth + 1, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;

    const record = value as Record<string, unknown>;
    const propertyNames = Object.getOwnPropertyNames(record);
    if (propertyNames.some((key) => !Object.prototype.propertyIsEnumerable.call(record, key))) return false;
    return propertyNames.every((key) => isVoiceProviderSettingsJsonValueV1(record[key], depth + 1, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

export const VoiceProviderSettingsJsonValueV1Schema = z.custom<VoiceProviderSettingsJsonValueV1>(
  (value): value is VoiceProviderSettingsJsonValueV1 => isVoiceProviderSettingsJsonValueV1(value),
  'Expected a serializable JSON value',
);

/**
 * Generic envelope validation deliberately does not interpret provider-owned
 * config. Resource bounds and provider-version migrations remain with the host
 * settings boundary and the owning bundled provider respectively.
 */
export const VoiceProviderSettingsEnvelopeV1Schema = z.object({
  schemaVersion: z.number().int().min(1).max(0x7fffffff),
  config: VoiceProviderSettingsJsonValueV1Schema,
});

export type VoiceProviderSettingsEnvelopeV1 = Readonly<
  z.infer<typeof VoiceProviderSettingsEnvelopeV1Schema>
>;

export const VoiceProviderSettingsRecordV1Schema = z.record(
  VoiceProviderIdSchema,
  VoiceProviderSettingsEnvelopeV1Schema,
);

export type VoiceProviderSettingsRecordV1 = Readonly<
  z.infer<typeof VoiceProviderSettingsRecordV1Schema>
>;
