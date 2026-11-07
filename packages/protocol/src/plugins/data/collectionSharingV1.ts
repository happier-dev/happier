import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PrincipalRefV1Schema } from '../../teams/principal.js';
import { ResourceAccessGrantRowV1Schema, ResourceCallerAccessV1Schema, ResourceAccessRecipientCensusV1Schema,
  ResourceRecipientKeyEnvelopeInputV1Schema, ResourceRecipientKeyEnvelopesV1Schema,
  ResourceRecipientKeyEnvelopeCommitInputV1Schema, ResourceRecipientKeyEnvelopeCommitResponseV1Schema } from '../../teams/resourceGrantAccessV1.js';
import { PluginCollectionContentEnvelopeV1Schema, PluginCollectionProjectionV1Schema, PluginCollectionRevisionV1Schema,
  PluginCollectionRowV1Schema, PluginCollectionRowIdV1Schema, PluginCollectionContractRefV1Schema,
  PluginCollectionReadErrorV1Schema, PluginCollectionMutationErrorV1Schema,
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from './collectionsV1.js';

export const PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 = {
  grants: '/v1/plugins/data/sharing/grants', census: '/v1/plugins/data/sharing/census',
  setGrant: '/v1/plugins/data/sharing/set-grant', revokeGrant: '/v1/plugins/data/sharing/revoke-grant',
  commitKeys: '/v1/plugins/data/sharing/commit-keys', get: '/v1/plugins/data/sharing/get',
  put: '/v1/plugins/data/sharing/put', sharedWithMe: '/v1/plugins/data/sharing/shared-with-me',
} as const;
const identity = () => ({ pluginId: asProtocolZod(PluginIdSchema), collectionId: asProtocolZod(PluginContributionLocalIdSchema) });
const address = () => ({ ...identity(), ownerAccountId: z.string().check(z.minLength(1)), rowId: PluginCollectionRowIdV1Schema });
export const PluginCollectionSharingAddressV1Schema = lazyZodSchema(() => z.strictObject(address()));
export type PluginCollectionSharingAddressV1 = z.infer<typeof PluginCollectionSharingAddressV1Schema>;
export const PluginCollectionSharingPromotionV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: PluginCollectionRevisionV1Schema, content: PluginCollectionContentEnvelopeV1Schema,
  ownerKeyEnvelope: ResourceRecipientKeyEnvelopeInputV1Schema, recipientKeyEnvelopes: ResourceRecipientKeyEnvelopesV1Schema,
}));
export const PluginCollectionSharingSetGrantRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...address(), principal: PrincipalRefV1Schema, accessLevel: z.enum(['view', 'edit']),
  expectedRevision: PluginCollectionRevisionV1Schema,
  promotion: z.optional(PluginCollectionSharingPromotionV1Schema),
  recipientKeyEnvelopes: z.optional(ResourceRecipientKeyEnvelopesV1Schema),
}));
export type PluginCollectionSharingSetGrantRequestV1 = z.infer<typeof PluginCollectionSharingSetGrantRequestV1Schema>;
export const PluginCollectionSharingRevokeGrantRequestV1Schema = lazyZodSchema(() => z.strictObject({ ...address(), principal: PrincipalRefV1Schema }));
export type PluginCollectionSharingRevokeGrantRequestV1 = z.infer<typeof PluginCollectionSharingRevokeGrantRequestV1Schema>;
export const PluginCollectionSharingCensusRequestV1Schema = lazyZodSchema(() => z.strictObject({ ...address(), principal: z.optional(PrincipalRefV1Schema) }));
export type PluginCollectionSharingCensusRequestV1 = z.infer<typeof PluginCollectionSharingCensusRequestV1Schema>;
export const PluginCollectionSharingCensusResponseV1Schema = lazyZodSchema(() => z.strictObject({ ...address(),
  ...ResourceAccessRecipientCensusV1Schema.shape,
}));
export type PluginCollectionSharingCensusResponseV1 = z.infer<typeof PluginCollectionSharingCensusResponseV1Schema>;
export const PluginCollectionSharingGrantsResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ...address(), access: ResourceCallerAccessV1Schema, grants: z.array(ResourceAccessGrantRowV1Schema),
}));
export type PluginCollectionSharingGrantsResponseV1 = z.infer<typeof PluginCollectionSharingGrantsResponseV1Schema>;
export const PluginCollectionSharingMutationResponseV1Schema = lazyZodSchema(() => z.strictObject({ changed: z.boolean() }));
export const PluginCollectionSharingCommitKeysRequestV1Schema = lazyZodSchema(() => z.strictObject({ ...address(), ...ResourceRecipientKeyEnvelopeCommitInputV1Schema.shape }));
export type PluginCollectionSharingCommitKeysRequestV1 = z.infer<typeof PluginCollectionSharingCommitKeysRequestV1Schema>;
export const PluginCollectionSharingCommitKeysResponseV1Schema = ResourceRecipientKeyEnvelopeCommitResponseV1Schema;
export const PluginCollectionSharingGetRequestV1Schema = lazyZodSchema(() => z.strictObject({ ...address(), readerContext: PluginCollectionContractRefV1Schema }));
export type PluginCollectionSharingGetRequestV1 = z.infer<typeof PluginCollectionSharingGetRequestV1Schema>;
export const PluginCollectionSharingResourceV1Schema = lazyZodSchema(() => z.strictObject({
  ...address(), access: ResourceCallerAccessV1Schema, encryptionMode: z.enum(['plain', 'e2ee']),
  encryptedDataKey: z.nullable(z.string()), row: PluginCollectionRowV1Schema,
}));
export type PluginCollectionSharingResourceV1 = z.infer<typeof PluginCollectionSharingResourceV1Schema>;
export const PluginCollectionSharingPutRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...address(), writerContext: PluginCollectionContractRefV1Schema, expectedRevision: PluginCollectionRevisionV1Schema,
  content: PluginCollectionContentEnvelopeV1Schema, projection: PluginCollectionProjectionV1Schema,
}));
export type PluginCollectionSharingPutRequestV1 = z.infer<typeof PluginCollectionSharingPutRequestV1Schema>;
export const PluginCollectionSharingListRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...identity(), readerContext: PluginCollectionContractRefV1Schema, cursor: z.optional(z.string()),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1))),
}));
export type PluginCollectionSharingListRequestV1 = z.infer<typeof PluginCollectionSharingListRequestV1Schema>;
export const PluginCollectionSharingListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  resources: z.array(PluginCollectionSharingResourceV1Schema), nextCursor: z.nullable(z.string()),
}));
export type PluginCollectionSharingListResponseV1 = z.infer<typeof PluginCollectionSharingListResponseV1Schema>;
export const PluginCollectionSharingErrorV1Schema = lazyZodSchema(() => z.union([
  PluginCollectionReadErrorV1Schema,
  PluginCollectionMutationErrorV1Schema,
  z.strictObject({ error: z.enum([
  'collection_access_forbidden', 'collection_content_unavailable', 'collection_revision_conflict',
  'collection_promotion_required', 'collection_invalid_recipient_envelope',
  'collection_owner_grant_invalid', 'collection_subject_not_found', 'collection_subject_ineligible',
]) }),
]));
export type PluginCollectionSharingErrorV1 = z.infer<typeof PluginCollectionSharingErrorV1Schema>['error'];
