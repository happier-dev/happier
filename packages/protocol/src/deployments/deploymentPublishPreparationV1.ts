import { DeploymentTargetRecommendationV1Schema } from './deploymentTargetRecommendationV1.js';
import { RegistryAppMappingV1Schema } from '../registries/registryAppMappingV1.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentTemplateRefV1Schema, DeploymentNewProjectV1Schema, hasOneDeploymentProjectV1 } from './storedAppInputV1.js';
import { DeploymentTemplateV1Schema } from '../plugins/contributions/deploymentTemplates.js';
import { ProjectSourceOwnerV1Schema } from '../projects/sources/projectSourceV1.js';
import { DeploymentCreationDefaultsV1Schema, ResolvedDeploymentCreationDefaultsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentTemplateInstantiationReviewV1Schema } from './deploymentTemplateInstantiationV1.js';
import { DeploymentTextV1Schema, DeploymentImageDefinitionInputV1Schema } from './storedAppInputV1.js';
import { readDeploymentDomainHostnameV1 } from './deploymentDomainContentV1.js';

/** Incomplete authoring text is data: an invalid field must not refuse the prepare read. */
export const DeploymentConfigureDraftV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string(), port: z.optional(z.union([z.string(), z.number()])), hostname: z.optional(z.string()),
}));
export type DeploymentConfigureDraftV1 = z.infer<typeof DeploymentConfigureDraftV1Schema>;
const fieldStatus = () => z.enum(['valid', 'invalid', 'notProvided']);
export const DeploymentConfigurePreflightV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.strictObject({ status: fieldStatus(), value: z.nullable(z.string()) }),
  port: z.strictObject({ status: fieldStatus(), value: z.nullable(DeploymentImageDefinitionInputV1Schema.shape.port) }),
  dns: z.strictObject({ status: fieldStatus(), value: z.nullable(z.string()) }),
}));
export type DeploymentConfigurePreflightV1 = z.infer<typeof DeploymentConfigurePreflightV1Schema>;

/** Same authoring schemas and Domain hostname owner; no uniqueness, listener or DNS probe. */
export function projectDeploymentConfigurePreflightV1(draft: DeploymentConfigureDraftV1): DeploymentConfigurePreflightV1 {
  const name = DeploymentTextV1Schema.safeParse(draft.name);
  const portText = typeof draft.port === 'string' ? draft.port.trim() : draft.port;
  const port = DeploymentImageDefinitionInputV1Schema.shape.port.safeParse(typeof portText === 'string'
    ? /^\d+$/u.test(portText) ? Number(portText) : Number.NaN : portText);
  const hostname = readDeploymentDomainHostnameV1(draft.hostname);
  return {
    name: { status: name.success ? 'valid' : 'invalid', value: name.success ? name.data : null },
    port: { status: portText === undefined || portText === '' ? 'notProvided' : port.success ? 'valid' : 'invalid',
      value: port.success ? port.data : null },
    dns: { status: !draft.hostname?.trim() ? 'notProvided' : hostname ? 'valid' : 'invalid', value: hostname },
  };
}

/** An inert catalog entry, before variable selection, content creation or Publish approval. */
export const DeploymentPublishPrepareInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, machineId: id, installationId: id, projectSourceId: z.optional(id), sourceRevision: z.optional(revision),
  newProject: z.optional(DeploymentNewProjectV1Schema),
  templateRef: DeploymentTemplateRefV1Schema,
  appMappingCorrection: z.optional(RegistryAppMappingV1Schema),
  explicit: z.optional(DeploymentCreationDefaultsV1Schema),
  configure: z.optional(DeploymentConfigureDraftV1Schema),
}).check(z.refine(input => hasOneDeploymentProjectV1(input.projectSourceId, input.newProject)
  && (input.projectSourceId === undefined ? input.sourceRevision === undefined : input.sourceRevision !== undefined),
  { message: 'Select an exact existing Source or reviewed new Project.' })));
export type DeploymentPublishPrepareInputV1 = z.infer<typeof DeploymentPublishPrepareInputV1Schema>;

/** P45's unchanged descriptor keeps unresolved variables, domains and provenance visible. */
export const DeploymentPublishPrepareResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('prepared'), templateRef: DeploymentTemplateRefV1Schema,
  project: z.strictObject({ projectSourceId: z.optional(id), sourceRevision: z.optional(revision),
    newProject: z.optional(DeploymentNewProjectV1Schema), owner: ProjectSourceOwnerV1Schema }).check(z.refine(project =>
      hasOneDeploymentProjectV1(project.projectSourceId, project.newProject)
      && (project.projectSourceId === undefined ? project.sourceRevision === undefined : project.sourceRevision !== undefined),
      { message: 'Prepared Project selection retains its exact existing or intended owner.' })),
  machine: z.strictObject({ machineId: id, installationId: id }),
  template: DeploymentTemplateV1Schema,
  recommendation: z.optional(DeploymentTargetRecommendationV1Schema),
  creationDefaults: ResolvedDeploymentCreationDefaultsV1Schema,
  creationDefaultsBasis: DeploymentTemplateInstantiationReviewV1Schema.shape.creationDefaultsBasis,
  configurePreflight: z.optional(DeploymentConfigurePreflightV1Schema),
}));
export type DeploymentPublishPrepareResultV1 = z.infer<typeof DeploymentPublishPrepareResultV1Schema>;
