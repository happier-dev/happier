import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { asProtocolZod } from '../../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../../../plugins/contributionIdentity.js';

/** Public client metadata, not a credential or proof of provider operation rights. */
export const ConnectedAccountPublicOAuthClientV1Schema = lazyZodSchema(() => z.object({
  service: asProtocolZod(PluginContributionIdentityV1Schema),
  clientId: z.string().check(z.trim(), z.minLength(1), z.refine(value => !/\p{Cc}/u.test(value))),
  scopesByMode: z.record(asProtocolZod(PluginContributionLocalIdSchema),
    z.array(z.string().check(z.regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/u))).check(z.minLength(1))),
}));

export const DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES = Object.freeze({
  revisionGuard: false,
});

export const ConnectedServicesCredentialDeleteCapabilitiesSchema = lazyZodSchema(() => z._default(z
  .object({
    revisionGuard: z._default(z.optional(z.boolean()), DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES.revisionGuard),
  }), DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES));

export const DEFAULT_CONNECTED_SERVICES_CAPABILITIES = Object.freeze({
  credentialDelete: DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES,
});

export const ConnectedServicesQualifiedAccountsCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(4),
}));

export const ConnectedServicesCredentialRemovalReviewCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
}));

export const ConnectedServicesCapabilitiesSchema = lazyZodSchema(() => z._default(z
  .object({
    credentialDelete: z._default(z.optional(ConnectedServicesCredentialDeleteCapabilitiesSchema), DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES),
    qualifiedAccounts: z.optional(ConnectedServicesQualifiedAccountsCapabilitiesSchema),
    credentialRemovalReview: z.optional(ConnectedServicesCredentialRemovalReviewCapabilitiesSchema),
    publicOAuthClients: z.catch(z.optional(z.array(ConnectedAccountPublicOAuthClientV1Schema)), undefined),
  }), DEFAULT_CONNECTED_SERVICES_CAPABILITIES));

export type ConnectedServicesCapabilities = z.infer<typeof ConnectedServicesCapabilitiesSchema>;
