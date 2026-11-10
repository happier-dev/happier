import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { BoundedLegacyJsonValueSchema } from './catalog/legacyJson.js';

export const CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY =
  'connectedAccountServiceConfigurationsV1';

export const CONNECTED_ACCOUNT_SERVICE_CONFIGURATION_MAX_ENTRIES = 256;

const MAX_CONFIGURATION_IDENTITY_LENGTH = 256;
const MAX_SECRET_REFERENCE_LENGTH = 512;
const MAX_FIELD_ID_LENGTH = 64 * 1024;

const BoundedConfigurationIdentitySchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(MAX_CONFIGURATION_IDENTITY_LENGTH)));

const ConnectedAccountServiceConfigurationValuesV1Schema = lazyZodSchema(() => z
  .record(z.string().check(z.maxLength(MAX_FIELD_ID_LENGTH)), BoundedLegacyJsonValueSchema));

const ConnectedAccountServiceConfigurationSecretRefsV1Schema = lazyZodSchema(() => z
  .record(
    z.string().check(z.maxLength(MAX_FIELD_ID_LENGTH)),
    z.string().check(z.minLength(1), z.maxLength(MAX_SECRET_REFERENCE_LENGTH)),
  ));

export const ConnectedAccountServiceConfigurationEntryV1Schema = lazyZodSchema(() => z.strictObject({
  service: z.strictObject({
    pluginId: BoundedConfigurationIdentitySchema,
    localId: BoundedConfigurationIdentitySchema,
  }),
  modeId: BoundedConfigurationIdentitySchema,
  revision: BoundedConfigurationIdentitySchema,
  values: ConnectedAccountServiceConfigurationValuesV1Schema,
  secretRefs: ConnectedAccountServiceConfigurationSecretRefsV1Schema,
}));

/** The domain catalog has one row; its transport owns the encoded size boundary. */
export const ConnectedAccountServiceConfigurationCatalogV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  entries: z.array(ConnectedAccountServiceConfigurationEntryV1Schema),
}).check(z.superRefine((value, ctx) => {
  const targets = new Set<string>();
  value.entries.forEach((entry, index) => {
    const target = JSON.stringify([
      entry.service.pluginId,
      entry.service.localId,
      entry.modeId,
    ]);
    if (targets.has(target)) {
      ctx.addIssue({
        code: "custom",
        path: ['entries', index],
        message: 'Connected Account service configuration target is duplicated',
      });
      return;
    }
    targets.add(target);
  });
})));

/** Retained Settings source only; current catalog writes use the domain schema. */
export const ConnectedAccountServiceConfigurationsV1Schema = lazyZodSchema(() =>
  z.safeExtend(ConnectedAccountServiceConfigurationCatalogV1Schema, {
    entries: z.array(ConnectedAccountServiceConfigurationEntryV1Schema).check(z.maxLength(CONNECTED_ACCOUNT_SERVICE_CONFIGURATION_MAX_ENTRIES)),
  }));

export type ConnectedAccountServiceConfigurationEntryV1 = z.infer<
  typeof ConnectedAccountServiceConfigurationEntryV1Schema
>;
export type ConnectedAccountServiceConfigurationsV1 = z.infer<
  typeof ConnectedAccountServiceConfigurationsV1Schema
>;

export function parseConnectedAccountServiceConfigurationsV1(
  input: unknown,
): ConnectedAccountServiceConfigurationsV1 {
  return ConnectedAccountServiceConfigurationsV1Schema.parse(input);
}
