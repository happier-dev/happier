import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PluginWebhookVerifierV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('github_hmac_sha256_v1'),
  routing: z.enum(['accountEndpoint', 'providerInstallation']),
}));
export type PluginWebhookVerifierV1 = z.infer<typeof PluginWebhookVerifierV1Schema>;

export const PluginWebhookContributionV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  verifier: PluginWebhookVerifierV1Schema,
  handlerAction: z.strictObject({
    localId: asProtocolZod(PluginContributionLocalIdSchema),
  }),
}), z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  verifier: z.strictObject({ kind: z.literal('capabilityUrl_v1'), routing: z.literal('accountEndpoint') }),
  delivery: z.literal('recordReceiptOnly'),
})]));
export type PluginWebhookContributionV1 = z.infer<typeof PluginWebhookContributionV1Schema>;
