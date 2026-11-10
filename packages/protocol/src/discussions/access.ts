import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PrincipalRefV1Schema } from '../teams/principal.js';
import {
  ResourceAccessGrantRowV1Schema, ResourceAccessLevelV1Schema, ResourceCallerAccessV1Schema,
  ResourceAccessRecipientCensusV1Schema, ResourceRecipientKeyEnvelopeCommitInputV1Schema,
  ResourceRecipientKeyEnvelopeCommitResponseV1Schema,
} from '../teams/resourceGrantAccessV1.js';
import { SessionMessageAccountActorV1Schema } from '../sessions/messages/sessionMessageAccountActorV1.js';
import { DiscussionAccountIdSchema, DiscussionIdSchema } from './content.js';

/** Only the resource identity is Discussion-owned; grants and envelopes use the shared owner. */
export const DiscussionAccessGrantSetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  principal: PrincipalRefV1Schema,
  accessLevel: ResourceAccessLevelV1Schema,
}));
export type DiscussionAccessGrantSetRequestV1 = z.infer<typeof DiscussionAccessGrantSetRequestV1Schema>;

export const DiscussionAccessGrantRemoveRequestV1Schema = lazyZodSchema(() => z.strictObject({
  principal: PrincipalRefV1Schema,
}));
export type DiscussionAccessGrantRemoveRequestV1 = z.infer<typeof DiscussionAccessGrantRemoveRequestV1Schema>;

export const DiscussionAccessGrantsListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  ownerAccountId: DiscussionAccountIdSchema,
  access: ResourceCallerAccessV1Schema,
  grants: z.array(ResourceAccessGrantRowV1Schema),
  /** Explicit relationship facts for Account principals and the owner; omitted by older development Homes. */
  accountActors: z.optional(z.array(SessionMessageAccountActorV1Schema)),
}));
export type DiscussionAccessGrantsListResponseV1 = z.infer<typeof DiscussionAccessGrantsListResponseV1Schema>;

export const DiscussionAccessGrantMutationResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ...DiscussionAccessGrantsListResponseV1Schema.shape,
  access: z.nullable(ResourceCallerAccessV1Schema),
  changed: z.boolean(),
}).check(z.refine(response => response.access !== null || response.grants.length === 0, {
  message: 'A revoked caller cannot receive the grant roster', path: ['grants'],
})));
export type DiscussionAccessGrantMutationResponseV1 = z.infer<typeof DiscussionAccessGrantMutationResponseV1Schema>;

/** A self-leave retry may have no remaining access; do not disclose the roster or owner. */
export const DiscussionLeaveResponseV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  access: z.nullable(ResourceCallerAccessV1Schema),
  changed: z.boolean(),
}));
export type DiscussionLeaveResponseV1 = z.infer<typeof DiscussionLeaveResponseV1Schema>;

export const DiscussionAccessRecipientCensusResponseV1Schema = lazyZodSchema(() => z.extend(ResourceAccessRecipientCensusV1Schema, {
  discussionId: DiscussionIdSchema,
  ownerAccountId: DiscussionAccountIdSchema,
}));
export type DiscussionAccessRecipientCensusResponseV1 = z.infer<typeof DiscussionAccessRecipientCensusResponseV1Schema>;

export const DiscussionRecipientKeyEnvelopeCommitInputV1Schema = ResourceRecipientKeyEnvelopeCommitInputV1Schema;
export type DiscussionRecipientKeyEnvelopeCommitInputV1 = z.infer<typeof DiscussionRecipientKeyEnvelopeCommitInputV1Schema>;

export const DiscussionRecipientKeyEnvelopeCommitResponseV1Schema = ResourceRecipientKeyEnvelopeCommitResponseV1Schema;
export type DiscussionRecipientKeyEnvelopeCommitResponseV1 = z.infer<typeof DiscussionRecipientKeyEnvelopeCommitResponseV1Schema>;
