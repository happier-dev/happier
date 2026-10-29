import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentTemplateRefV1Schema } from './storedAppInputV1.js';
import { DeploymentTemplateV1Schema } from '../plugins/contributions/deploymentTemplates.js';
import { ProjectSourceOwnerV1Schema } from '../projects/sources/projectSourceV1.js';
import { DeploymentCreationDefaultsV1Schema, ResolvedDeploymentCreationDefaultsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentTemplateInstantiationReviewV1Schema } from './deploymentTemplateInstantiationV1.js';

/** An inert catalog entry, before variable selection, content creation or Publish approval. */
export const DeploymentPublishPrepareInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, machineId: id, installationId: id, projectSourceId: id, sourceRevision: revision,
  templateRef: DeploymentTemplateRefV1Schema,
  explicit: z.optional(DeploymentCreationDefaultsV1Schema),
}));
export type DeploymentPublishPrepareInputV1 = z.infer<typeof DeploymentPublishPrepareInputV1Schema>;

/** P45's unchanged descriptor keeps unresolved variables, domains and provenance visible. */
export const DeploymentPublishPrepareResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('prepared'), templateRef: DeploymentTemplateRefV1Schema,
  project: z.strictObject({ projectSourceId: id, sourceRevision: revision, owner: ProjectSourceOwnerV1Schema }),
  machine: z.strictObject({ machineId: id, installationId: id }),
  template: DeploymentTemplateV1Schema,
  creationDefaults: ResolvedDeploymentCreationDefaultsV1Schema,
  creationDefaultsBasis: DeploymentTemplateInstantiationReviewV1Schema.shape.creationDefaultsBasis,
}));
export type DeploymentPublishPrepareResultV1 = z.infer<typeof DeploymentPublishPrepareResultV1Schema>;
