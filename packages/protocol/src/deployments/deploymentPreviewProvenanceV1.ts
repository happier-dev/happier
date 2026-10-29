import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';

/** Protected provenance only; the admitted template relation owns live Action preferences. */
export const DeploymentPreviewProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), templateEnvironmentId: id, runtimeTargetLinkId: id,
  repository: ScmHostingRepositoryIdentityV1Schema,
  pullRequestId: id, pullRequestNumber: z.number().check(z.int(), z.positive()),
  author: z.strictObject({ id, login: z.string().check(z.trim(), z.minLength(1)) }),
  headRepository: ScmHostingRepositoryIdentityV1Schema,
}));
export type DeploymentPreviewProvenanceV1 = z.infer<typeof DeploymentPreviewProvenanceV1Schema>;
export const DeploymentPreviewProvenanceV1ProtocolSchema = projectZodProtocolSchema(DeploymentPreviewProvenanceV1Schema);
