import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PrincipalRefV1Schema } from './principal.js';
import { TeamGroupNameProjectionV1Schema } from './groupLabel.js';
import { ContentPublicKeyFingerprintSchema } from '../machines/identity/contentPublicKeyFingerprint.js';
import { SessionDataKeyEnvelopeBytesV1Schema, SessionDataKeyRecipientContentKeyV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';

/** Shared grant/envelope vocabulary. Resource addresses and mutations stay resource-owned. */
export const ResourceAccessLevelV1Schema = lazyZodSchema(() => z.enum(['view', 'edit', 'admin']));
export type ResourceAccessLevelV1 = z.infer<typeof ResourceAccessLevelV1Schema>;
export const ResourceCallerAccessV1Schema = lazyZodSchema(() => z.enum(['owner', 'view', 'edit', 'admin']));
export type ResourceCallerAccessV1 = z.infer<typeof ResourceCallerAccessV1Schema>;
/** Selected-Team page provenance, without disclosing private Group identities. */
export const ResourceTeamShareScopeV1Schema = z.enum(['team', 'group', 'team_and_group']);
export type ResourceTeamShareScopeV1 = z.infer<typeof ResourceTeamShareScopeV1Schema>;
export function resourceTeamShareScopeV1(input: Readonly<{ team: boolean; group: boolean }>): ResourceTeamShareScopeV1 | undefined {
  return input.team ? input.group ? 'team_and_group' : 'team' : input.group ? 'group' : undefined;
}
export const ResourceAccessGrantRowV1Schema = lazyZodSchema(() => z.strictObject({
  principal: PrincipalRefV1Schema,
  accessLevel: ResourceAccessLevelV1Schema,
  createdByAccountId: z.string().check(z.minLength(1)),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  display: z.strictObject({ name: z.nullable(z.string()), username: z.optional(z.nullable(z.string())) }),
  /** Present only for Group principals; server text stays sealed in this projection. */
  groupName: z.optional(TeamGroupNameProjectionV1Schema),
}));
export type ResourceAccessGrantRowV1 = z.infer<typeof ResourceAccessGrantRowV1Schema>;
export const ResourceRecipientKeyEnvelopeInputV1Schema = lazyZodSchema(() => z.strictObject({
  recipientAccountId: z.string().check(z.minLength(1)),
  encryptedDataKey: SessionDataKeyEnvelopeBytesV1Schema,
  recipientContentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema,
}));
export type ResourceRecipientKeyEnvelopeInputV1 = z.infer<typeof ResourceRecipientKeyEnvelopeInputV1Schema>;
export function resourceRecipientAccountIdsAreUnique(items: readonly Readonly<{ recipientAccountId: string }>[]): boolean {
  return new Set(items.map(item => item.recipientAccountId)).size === items.length;
}
export const ResourceRecipientKeyEnvelopesV1Schema = lazyZodSchema(() => z.array(ResourceRecipientKeyEnvelopeInputV1Schema)
  .check(z.refine(resourceRecipientAccountIdsAreUnique, { message: 'Duplicate recipientAccountId' })));
export const ResourceRecipientKeyEnvelopeCommitInputV1Schema = lazyZodSchema(() => z.strictObject({
  expectedDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema,
  recipientKeyEnvelopes: ResourceRecipientKeyEnvelopesV1Schema,
}));
export type ResourceRecipientKeyEnvelopeCommitInputV1 = z.infer<typeof ResourceRecipientKeyEnvelopeCommitInputV1Schema>;
export const ResourceRecipientCensusRowV1Schema = lazyZodSchema(() => z.strictObject({
  recipientAccountId: z.string().check(z.minLength(1)),
  contentKey: SessionDataKeyRecipientContentKeyV1Schema,
  contentPublicKeyFingerprint: z.nullable(ContentPublicKeyFingerprintSchema),
  encryptedDataKey: z.nullable(SessionDataKeyEnvelopeBytesV1Schema),
  recipientContentPublicKeyFingerprint: z.nullable(ContentPublicKeyFingerprintSchema),
}));
export type ResourceRecipientCensusRowV1 = z.infer<typeof ResourceRecipientCensusRowV1Schema>;
export const ResourceAccessRecipientCensusV1Schema = lazyZodSchema(() => z.strictObject({
  ownerAccountId: z.string().check(z.minLength(1)),
  encryptionMode: AccountEncryptionModeSchema,
  access: ResourceCallerAccessV1Schema,
  dataEncryptionKey: z.nullable(SessionDataKeyEnvelopeBytesV1Schema),
  callerDataEncryptionKey: z.nullable(SessionDataKeyEnvelopeBytesV1Schema),
  recipients: z.array(ResourceRecipientCensusRowV1Schema),
}));
export type ResourceAccessRecipientCensusV1 = z.infer<typeof ResourceAccessRecipientCensusV1Schema>;
export const ResourceRecipientKeyEnvelopeCommitResponseV1Schema = lazyZodSchema(() => z.strictObject({
  appliedRecipientAccountIds: z.array(z.string().check(z.minLength(1))),
  skippedRecipientAccountIds: z.array(z.string().check(z.minLength(1))),
}));
export type ResourceRecipientKeyEnvelopeCommitResponseV1 = z.infer<typeof ResourceRecipientKeyEnvelopeCommitResponseV1Schema>;
