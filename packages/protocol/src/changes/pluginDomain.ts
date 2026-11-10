import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginAccountStorageLogicalKeyV1Schema } from '../plugins/data/accountKvV1.js';
import {
  PluginCollectionContractDigestV1Schema,
  PluginCollectionRowIdV1Schema,
  PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1,
} from '../plugins/data/collectionsV1.js';
import { PluginCollectionMemberNameV1Schema } from '../plugins/data/collectionContributionV1.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

const AccountChangeCursorSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
const AccountChangeTimestampSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
const AccountChangeRevisionSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));

function uniqueArray<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const PluginDomainDataKvKeysChangeHintSchema = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('dataKv'),
  pluginId: asProtocolZod(PluginIdSchema),
  keys: z.array(PluginAccountStorageLogicalKeyV1Schema).check(z.minLength(1), z.maxLength(200), z.refine(uniqueArray, 'Plugin Account KV invalidation keys must be unique.')),
}));
const PluginDomainDataKvFullChangeHintSchema = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('dataKv'),
  pluginId: asProtocolZod(PluginIdSchema),
  full: z.literal(true),
}));
export const PluginDomainDataKvChangeHintSchema = lazyZodSchema(() => z.union([
  PluginDomainDataKvKeysChangeHintSchema,
  PluginDomainDataKvFullChangeHintSchema,
]));
export type PluginDomainDataKvChangeHint = z.infer<typeof PluginDomainDataKvChangeHintSchema>;

/** One batch: at most 200 changed rows, eight indexes, and old/new keys. */
const PluginCollectionIndexChangesSchema = lazyZodSchema(() => z.strictObject({
  previousCursor: AccountChangeCursorSchema,
  keys: z.array(z.strictObject({
    indexId: PluginCollectionMemberNameV1Schema,
    key: z.string().check(z.maxLength(PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1 * 2), z.regex(/^(?:[0-9a-f]{2})+$/)),
  })).check(z.maxLength(200 * 8 * 2)),
}));
export type PluginCollectionIndexChanges = z.infer<typeof PluginCollectionIndexChangesSchema>;

const PluginDomainDataCollectionRowIdsChangeHintSchema = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('dataCollection'),
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  contractDigest: PluginCollectionContractDigestV1Schema,
  revision: AccountChangeRevisionSchema,
  rowIds: z.array(PluginCollectionRowIdV1Schema).check(z.minLength(1), z.maxLength(200), z.refine(uniqueArray, 'Collection invalidation row IDs must be unique.')),
  indexChanges: z.optional(PluginCollectionIndexChangesSchema),
}));
const PluginDomainDataCollectionFullChangeHintSchema = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('dataCollection'),
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  contractDigest: PluginCollectionContractDigestV1Schema,
  revision: AccountChangeRevisionSchema,
  full: z.literal(true),
}));
export const PluginDomainDataCollectionChangeHintSchema = lazyZodSchema(() => z.union([
  PluginDomainDataCollectionRowIdsChangeHintSchema,
  PluginDomainDataCollectionFullChangeHintSchema,
]));
export type PluginDomainDataCollectionChangeHint = z.infer<typeof PluginDomainDataCollectionChangeHintSchema>;

export const PluginDomainSettingsChangeHintSchema = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('settings'),
  pluginId: asProtocolZod(PluginIdSchema),
  scope: z.literal('account'),
  revision: AccountChangeRevisionSchema,
}));
export type PluginDomainSettingsChangeHint = z.infer<typeof PluginDomainSettingsChangeHintSchema>;

/**
 * Availability is level-triggered. The cursor establishes ordering; consumers
 * re-read the canonical Availability projection rather than derive state from
 * the invalidation row.
 */
export const PluginDomainAvailabilityChangeHintSchema = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('availability'),
  pluginId: asProtocolZod(PluginIdSchema),
}));
export type PluginDomainAvailabilityChangeHint = z.infer<typeof PluginDomainAvailabilityChangeHintSchema>;

/** Webhook consumers re-read bounded endpoint/queue status from its owner. */
export const PluginDomainWebhookChangeHintSchema = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('webhook'),
  pluginId: asProtocolZod(PluginIdSchema),
}));
export type PluginDomainWebhookChangeHint = z.infer<typeof PluginDomainWebhookChangeHintSchema>;

/**
 * This intentionally has no catch-all arm. A later specialist needs an
 * approved positive consumer to amend this incumbent union once.
 */
export const PluginDomainChangeHintSchema = lazyZodSchema(() => z.union([
  PluginDomainDataKvChangeHintSchema,
  PluginDomainDataCollectionChangeHintSchema,
  PluginDomainSettingsChangeHintSchema,
  PluginDomainAvailabilityChangeHintSchema,
  PluginDomainWebhookChangeHintSchema,
]));
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

export const PluginDomainChangeEntrySchema = lazyZodSchema(() => z.strictObject({
  cursor: AccountChangeCursorSchema,
  kind: z.literal('pluginDomain'),
  entityId: z.string().check(z.minLength(1)),
  changedAt: AccountChangeTimestampSchema,
  hint: PluginDomainChangeHintSchema,
}).check(z.superRefine((entry, context) => {
  if (entry.entityId !== buildPluginDomainAccountChangeEntityId(entry.hint)) {
    context.addIssue({
      code: "custom",
      path: ['entityId'],
      message: 'pluginDomain AccountChange entityId does not match its hint identity.',
    });
  }
})));
export type PluginDomainChangeEntry = z.infer<typeof PluginDomainChangeEntrySchema>;
