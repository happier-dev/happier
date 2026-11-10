import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { TeamCredentialDirectMaterialIdentityV1Schema } from './directMaterialCensusV1.js';

export const TeamCredentialSourceVersionV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256)));
export const TeamCredentialProviderModelDirectMaterialUseV1Schema = lazyZodSchema(() => z.strictObject({
    resourceId: TeamCredentialDirectMaterialIdentityV1Schema,
    slot: z.strictObject({ kind: z.literal('provider_model') }),
    sourceMemberKey: TeamCredentialSourceVersionV1Schema,
  }));
export const TeamCredentialConnectedServiceDirectMaterialUseV1Schema = lazyZodSchema(() => z.strictObject({
    resourceId: TeamCredentialDirectMaterialIdentityV1Schema,
    slot: z.strictObject({
      kind: z.literal('connected_service_purpose'),
      purpose: QualifiedConnectedAccountPurposeV1Schema,
    }),
    disclosedMember: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }));
export const TeamCredentialDirectMaterialUseV1Schema = lazyZodSchema(() => z.union([
  TeamCredentialProviderModelDirectMaterialUseV1Schema,
  TeamCredentialConnectedServiceDirectMaterialUseV1Schema,
]));
export type TeamCredentialDirectMaterialUseV1 = z.infer<
  typeof TeamCredentialDirectMaterialUseV1Schema
>;
