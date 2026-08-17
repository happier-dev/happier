import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginAccountStorageLogicalKeyV1Schema } from '../plugins/data/accountKvV1.js';
import {
  PluginCollectionContractDigestV1Schema,
  PluginCollectionRowIdV1Schema,
} from '../plugins/data/collectionsV1.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

const AccountChangeCursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const AccountChangeTimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const AccountChangeRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function uniqueArray<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const PluginDomainDataKvKeysChangeHintSchema = z.object({
  pluginDomain: z.literal('dataKv'),
  pluginId: asProtocolZod(PluginIdSchema),
  keys: z.array(PluginAccountStorageLogicalKeyV1Schema).min(1).max(200).refine(
    uniqueArray,
    'Plugin Account KV invalidation keys must be unique.',
  ),
}).strict();
const PluginDomainDataKvFullChangeHintSchema = z.object({
  pluginDomain: z.literal('dataKv'),
  pluginId: asProtocolZod(PluginIdSchema),
  full: z.literal(true),
}).strict();
export const PluginDomainDataKvChangeHintSchema = z.union([
  PluginDomainDataKvKeysChangeHintSchema,
  PluginDomainDataKvFullChangeHintSchema,
]);
export type PluginDomainDataKvChangeHint = z.infer<typeof PluginDomainDataKvChangeHintSchema>;

const PluginDomainDataCollectionRowIdsChangeHintSchema = z.object({
  pluginDomain: z.literal('dataCollection'),
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  contractDigest: PluginCollectionContractDigestV1Schema,
  revision: AccountChangeRevisionSchema,
  rowIds: z.array(PluginCollectionRowIdV1Schema).min(1).max(200).refine(
    uniqueArray,
    'Collection invalidation row IDs must be unique.',
  ),
}).strict();
const PluginDomainDataCollectionFullChangeHintSchema = z.object({
  pluginDomain: z.literal('dataCollection'),
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  contractDigest: PluginCollectionContractDigestV1Schema,
  revision: AccountChangeRevisionSchema,
  full: z.literal(true),
}).strict();
export const PluginDomainDataCollectionChangeHintSchema = z.union([
  PluginDomainDataCollectionRowIdsChangeHintSchema,
  PluginDomainDataCollectionFullChangeHintSchema,
]);
export type PluginDomainDataCollectionChangeHint = z.infer<typeof PluginDomainDataCollectionChangeHintSchema>;

export const PluginDomainSettingsChangeHintSchema = z.object({
  pluginDomain: z.literal('settings'),
  pluginId: asProtocolZod(PluginIdSchema),
  scope: z.literal('account'),
  revision: AccountChangeRevisionSchema,
}).strict();
export type PluginDomainSettingsChangeHint = z.infer<typeof PluginDomainSettingsChangeHintSchema>;

/**
 * Availability is level-triggered. The cursor establishes ordering; consumers
 * re-read the canonical Availability projection rather than derive state from
 * the invalidation row.
 */
export const PluginDomainAvailabilityChangeHintSchema = z.object({
  pluginDomain: z.literal('availability'),
  pluginId: asProtocolZod(PluginIdSchema),
}).strict();
export type PluginDomainAvailabilityChangeHint = z.infer<typeof PluginDomainAvailabilityChangeHintSchema>;

/** Webhook consumers re-read bounded endpoint/queue status from its owner. */
export const PluginDomainWebhookChangeHintSchema = z.object({
  pluginDomain: z.literal('webhook'),
  pluginId: asProtocolZod(PluginIdSchema),
}).strict();
export type PluginDomainWebhookChangeHint = z.infer<typeof PluginDomainWebhookChangeHintSchema>;

/**
 * This intentionally has no catch-all arm. A later specialist needs an
 * approved positive consumer to amend this incumbent union once.
 */
export const PluginDomainChangeHintSchema = z.union([
  PluginDomainDataKvChangeHintSchema,
  PluginDomainDataCollectionChangeHintSchema,
  PluginDomainSettingsChangeHintSchema,
  PluginDomainAvailabilityChangeHintSchema,
  PluginDomainWebhookChangeHintSchema,
]);
export type PluginDomainChangeHint = z.infer<typeof PluginDomainChangeHintSchema>;

export function buildPluginDomainAccountChangeEntityId(input: unknown): string {
  const hint = PluginDomainChangeHintSchema.parse(input);
  switch (hint.pluginDomain) {
    case 'dataKv':
      return `pluginDomain/${hint.pluginId}/data-kv`;
    case 'dataCollection':
      return `pluginDomain/${hint.pluginId}/data-collection/${hint.collectionId}`;
    case 'settings':
      return `pluginDomain/${hint.pluginId}/settings`;
    case 'availability':
      return `pluginDomain/${hint.pluginId}/availability`;
    case 'webhook':
      return `pluginDomain/${hint.pluginId}/webhook`;
  }
}

export const PluginDomainChangeEntrySchema = z.object({
  cursor: AccountChangeCursorSchema,
  kind: z.literal('pluginDomain'),
  entityId: z.string().min(1),
  changedAt: AccountChangeTimestampSchema,
  hint: PluginDomainChangeHintSchema,
}).strict().superRefine((entry, context) => {
  if (entry.entityId !== buildPluginDomainAccountChangeEntityId(entry.hint)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entityId'],
      message: 'pluginDomain AccountChange entityId does not match its hint identity.',
    });
  }
});
export type PluginDomainChangeEntry = z.infer<typeof PluginDomainChangeEntrySchema>;
