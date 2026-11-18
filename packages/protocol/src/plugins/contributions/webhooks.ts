import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

/** Signed verifier vocabulary shared by declaration and authenticated delivery. */
export const PluginWebhookSignedVerifierKindV1Schema = lazyZodSchema(() => z.enum([
  'github_hmac_sha256_v1', 'sentry_hmac_sha256_v1', 'gitlab_token_v1', 'bitbucket_hmac_sha256_v1',
]));

/** Only GitHub additionally supports provider-installation routing. */
export const PluginWebhookVerifierV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: PluginWebhookSignedVerifierKindV1Schema,
    routing: z.literal('accountEndpoint'),
  }),
  z.strictObject({
    kind: z.literal('github_hmac_sha256_v1'),
    routing: z.literal('providerInstallation'),
  }),
  z.strictObject({
    kind: z.literal('capabilityUrl_v1'),
    routing: z.literal('accountEndpoint'),
  }),
]));
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
