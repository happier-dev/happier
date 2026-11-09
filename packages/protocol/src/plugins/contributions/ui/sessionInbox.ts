import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { ActionSessionAddressV1Schema } from '../../../actions/sessionTargetV1.js';
import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { PluginIdSchema } from '../../pluginId.js';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import { PluginDeclarativeButtonsV1Schema } from '../declarativeButtonsV1.js';

/** Declared on the surface-scoped index Resource, never supplied by row data. */
export const PluginSessionInboxResourceBindingV1Schema = lazyZodSchema(() => z.strictObject({
  detailResourceId: asProtocolZod(PluginContributionLocalIdSchema),
}));
export type PluginSessionInboxResourceBindingV1 = z.infer<typeof PluginSessionInboxResourceBindingV1Schema>;

export const PluginSessionInboxRowV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  session: ActionSessionAddressV1Schema,
  title: z.string().check(z.minLength(1)),
  detail: z.nullable(z.string()),
  /** Retained PR observation selected by its owner; presentation grants no mutation authority. */
  landing: z.optional(z.strictObject({
    number: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
    url: z.string().check(z.url()),
    title: z.optional(z.nullable(z.string())),
    state: z.enum(['open', 'merged', 'closed', 'unknown']),
    observedAt: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
  })),
  detailResource: z.strictObject({
    pluginId: asProtocolZod(PluginIdSchema),
    resourceId: asProtocolZod(PluginContributionLocalIdSchema),
  }),
  controls: z.optional(PluginDeclarativeButtonsV1Schema),
}));
export type PluginSessionInboxRowV1 = z.infer<typeof PluginSessionInboxRowV1Schema>;

/** Closed presentation data. Resource admission supplies identity and read authority. */
export const PluginSessionInboxRowPageV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), rows: z.array(PluginSessionInboxRowV1Schema),
    nextCursor: z.nullable(z.string().check(z.minLength(1))) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['locked', 'unavailable', 'denied', 'sourceUnavailable']) }),
]));
export type PluginSessionInboxRowPageV1 = z.infer<typeof PluginSessionInboxRowPageV1Schema>;
