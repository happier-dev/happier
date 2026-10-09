import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { BoundedLegacyJsonValueSchema } from './catalog/legacyJson.js';

export const CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY =
  'connectedAccountServiceConfigurationsV1';

export const CONNECTED_ACCOUNT_SERVICE_CONFIGURATION_MAX_ENTRIES = 256;

const MAX_CONFIGURATION_IDENTITY_LENGTH = 256;
const MAX_SECRET_REFERENCE_LENGTH = 512;
const MAX_FIELD_ID_LENGTH = 64 * 1024;

const BoundedConfigurationIdentitySchema = lazyZodSchema(() => z.string()
  .min(1)
  .max(MAX_CONFIGURATION_IDENTITY_LENGTH));

const ConnectedAccountServiceConfigurationValuesV1Schema = lazyZodSchema(() => z
  .record(z.string().max(MAX_FIELD_ID_LENGTH), BoundedLegacyJsonValueSchema));

const ConnectedAccountServiceConfigurationSecretRefsV1Schema = lazyZodSchema(() => z
  .record(
    z.string().max(MAX_FIELD_ID_LENGTH),
    z.string().min(1).max(MAX_SECRET_REFERENCE_LENGTH),
  ));

export const ConnectedAccountServiceConfigurationEntryV1Schema = lazyZodSchema(() => z.object({
  service: z.object({
    pluginId: BoundedConfigurationIdentitySchema,
    localId: BoundedConfigurationIdentitySchema,
  }).strict(),
  modeId: BoundedConfigurationIdentitySchema,
  revision: BoundedConfigurationIdentitySchema,
  values: ConnectedAccountServiceConfigurationValuesV1Schema,
  secretRefs: ConnectedAccountServiceConfigurationSecretRefsV1Schema,
}).strict());

/** The domain catalog has one row; its transport owns the encoded size boundary. */
export const ConnectedAccountServiceConfigurationCatalogV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  entries: z.array(ConnectedAccountServiceConfigurationEntryV1Schema),
}).strict().superRefine((value, ctx) => {
  const targets = new Set<string>();
  value.entries.forEach((entry, index) => {
    const target = JSON.stringify([
      entry.service.pluginId,
      entry.service.localId,
      entry.modeId,
    ]);
    if (targets.has(target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index],
        message: 'Connected Account service configuration target is duplicated',
      });
      return;
    }
    targets.add(target);
  });
}));

/** Retained Settings source only; current catalog writes use the domain schema. */
export const ConnectedAccountServiceConfigurationsV1Schema = lazyZodSchema(() =>
  ConnectedAccountServiceConfigurationCatalogV1Schema.safeExtend({
    entries: z.array(ConnectedAccountServiceConfigurationEntryV1Schema)
      .max(CONNECTED_ACCOUNT_SERVICE_CONFIGURATION_MAX_ENTRIES),
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
