import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { TeamCredentialDirectMaterialIdentityV1Schema } from './directMaterialCensusV1.js';

/** One declared credential purpose within the requester's finite Action. */
export const TeamCredentialActionOperationConsumerV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('action_operation'),
  operationId: TeamCredentialDirectMaterialIdentityV1Schema,
  actionId: TeamCredentialDirectMaterialIdentityV1Schema,
  pluginVersion: TeamCredentialDirectMaterialIdentityV1Schema,
  purpose: QualifiedConnectedAccountPurposeV1Schema,
}));
export type TeamCredentialActionOperationConsumerV1 = z.infer<typeof TeamCredentialActionOperationConsumerV1Schema>;
