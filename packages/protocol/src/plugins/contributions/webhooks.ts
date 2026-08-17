import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PluginWebhookVerifierV1Schema = z.object({
  kind: z.literal('github_hmac_sha256_v1'),
  routing: z.enum(['accountEndpoint', 'providerInstallation']),
}).strict();
export type PluginWebhookVerifierV1 = z.infer<typeof PluginWebhookVerifierV1Schema>;

export const PluginWebhookContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  verifier: PluginWebhookVerifierV1Schema,
  handlerAction: z.object({
    localId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
}).strict();
export type PluginWebhookContributionV1 = z.infer<typeof PluginWebhookContributionV1Schema>;
