import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentCreationDefaultsV1Schema } from './deploymentCreationDefaultsV1.js';
import { ProjectSourceV1Schema } from './sources/projectSourceV1.js';
import { ProjectSourcesReadInputV1Schema } from './sources/projectSourceV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from '../deployments/deploymentArtifactContentReferenceV1.js';

/** Shared private leaf of the existing Project/Source, never Account organization content. */
export const ProjectDeploymentDefaultsPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  projectSourceId: ProjectSourceV1Schema.shape.id,
  deploymentDefaults: DeploymentCreationDefaultsV1Schema,
}));
export type ProjectDeploymentDefaultsPayloadV1 = z.infer<typeof ProjectDeploymentDefaultsPayloadV1Schema>;

export const ProjectDeploymentDefaultsContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: ProjectDeploymentDefaultsPayloadV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type ProjectDeploymentDefaultsContentV1 = z.infer<typeof ProjectDeploymentDefaultsContentV1Schema>;

export const ProjectDeploymentDefaultsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), projectSourceId: ProjectSourceV1Schema.shape.id,
  revision: ProjectSourceV1Schema.shape.revision,
  content: ProjectDeploymentDefaultsContentV1Schema,
}).check(z.refine(row => row.content.t !== 'plain' || row.content.v.projectSourceId === row.projectSourceId,
  { message: 'Project defaults payload must belong to the requested Source.' })));
export type ProjectDeploymentDefaultsV1 = z.infer<typeof ProjectDeploymentDefaultsV1Schema>;

/** Storage carries the Artifact address; the existing Artifact owner admits mode and recipients. */
export const ProjectDeploymentDefaultsReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: ProjectSourcesReadInputV1Schema.shape.serverId,
  projectSourceId: ProjectSourceV1Schema.shape.id,
}));
const defaultsRevision = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0)));
export const ProjectDeploymentDefaultsSetInputV1Schema = lazyZodSchema(() => z.extend(ProjectDeploymentDefaultsReadInputV1Schema, {
  expectedSourceRevision: ProjectSourceV1Schema.shape.revision,
  expectedRevision: defaultsRevision,
  content: z.nullable(DeploymentArtifactContentReferenceV1Schema),
}));
export const ProjectDeploymentDefaultsFailureV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false), error: z.enum(['project_defaults_invalid', 'project_defaults_unavailable',
    'project_defaults_access_denied', 'project_defaults_conflict', 'project_defaults_content_unavailable']),
}));
export const ProjectDeploymentDefaultsOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), projectSourceId: ProjectSourceV1Schema.shape.id,
    sourceRevision: ProjectSourceV1Schema.shape.revision, revision: defaultsRevision,
    content: z.nullable(DeploymentArtifactContentReferenceV1Schema) }),
  ProjectDeploymentDefaultsFailureV1Schema,
]));
export const ProjectDeploymentDefaultsChangeHintV1Schema = lazyZodSchema(() => z.strictObject({
  projectSourceId: ProjectSourceV1Schema.shape.id, key: z.literal('deploymentDefaults'), revision: defaultsRevision,
}));
export type ProjectDeploymentDefaultsReadInputV1 = z.infer<typeof ProjectDeploymentDefaultsReadInputV1Schema>;
export type ProjectDeploymentDefaultsSetInputV1 = z.infer<typeof ProjectDeploymentDefaultsSetInputV1Schema>;
export type ProjectDeploymentDefaultsOutputV1 = z.infer<typeof ProjectDeploymentDefaultsOutputV1Schema>;
export type ProjectDeploymentDefaultsChangeHintV1 = z.infer<typeof ProjectDeploymentDefaultsChangeHintV1Schema>;
