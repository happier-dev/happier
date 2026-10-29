import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision,
    DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';

export const DeploymentDomainStateV1Schema = lazyZodSchema(() => z.enum([
    'pending', 'applying', 'active', 'warning', 'failed', 'removing',
]));

/** Source-admitted metadata records a reference, not current private-body access. */
export const DeploymentDomainHeaderV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), id, environmentId: id, targetLinkId: id, revision,
    state: DeploymentDomainStateV1Schema, ...DeploymentArtifactContentReferenceV1Schema.shape,
    createdByAccountId: id, observedAtMs: z.optional(timestamp),
    createdAtMs: timestamp, updatedAtMs: timestamp, deletedAtMs: z.optional(timestamp),
}));
export type DeploymentDomainHeaderV1 = z.infer<typeof DeploymentDomainHeaderV1Schema>;
