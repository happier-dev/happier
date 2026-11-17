import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectEffectiveDefinitionV1Schema, resolveProjectDefinitionV1 } from '../workspaces/projectSetup/projectDefinitionCompositionV1.js';
import type { ProjectManifestV1 } from '../workspaces/projectSetup/projectManifestV1.js';
import { ProjectSetupReviewV1Schema, ProjectSetupReadinessV1Schema } from '../actions/projectSetupConsentFailure.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import { ProjectSetupSelectionV1Schema, ProjectSharedSetupV1Schema, PROJECT_SETUP_ARTIFACT_KIND_V1,
  projectSharedSetupDigestV1, type ProjectAcceptedSharedSetupV1, type ProjectSetupArtifactV1, type ProjectSetupReadV1 } from './projectSetupV1.js';
import type { ProjectSourceV1 } from './sources/projectSourceV1.js';

/** A demanded update review. Ordinary inspection and launch never read upstream content. */
export const ProjectSharedSetupChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current'), selection: ProjectSetupSelectionV1Schema }),
  z.strictObject({ kind: z.literal('changed'), selection: ProjectSetupSelectionV1Schema,
    before: ProjectEffectiveDefinitionV1Schema, after: ProjectEffectiveDefinitionV1Schema,
    setupReadiness: ProjectSetupReadinessV1Schema,
    setupReview: z.optional(ProjectSetupReviewV1Schema) }),
  z.strictObject({ kind: z.literal('upstreamUnavailable'), code: z.string().check(z.minLength(1)),
    failureCause: z.optional(ActionFailureCauseV1Schema) }),
]));
export type ProjectSharedSetupChangeV1 = z.infer<typeof ProjectSharedSetupChangeV1Schema>;

/** Publication admission is shared by acceptance and update review, including the selected revision. */
export async function readPublishedProjectSetupV1(input: Readonly<{
  source: ProjectSourceV1; readArtifact(artifactId: string, projectSourceId: string): Promise<ProjectSetupArtifactV1 | null>;
}>): Promise<ProjectAcceptedSharedSetupV1> {
  const refuse = (): never => { throw Object.assign(new Error('project_setup_review_unavailable'), { code: 'project_setup_review_unavailable' }); };
  const attachment = input.source.attachments?.find(value => value.purpose === 'setup');
  if (!attachment || attachment.ref.kind !== 'doc') return refuse();
  const artifact = await input.readArtifact(attachment.ref.artifactId, input.source.id);
  if (!artifact || artifact.artifactId !== attachment.ref.artifactId || artifact.header.kind !== PROJECT_SETUP_ARTIFACT_KIND_V1
    || typeof artifact.body !== 'string' || artifact.revision.headerVersion !== attachment.contentRevision.headerVersion
    || artifact.revision.bodyVersion !== attachment.contentRevision.bodyVersion) return refuse();
  let document: unknown;
  try { document = JSON.parse(artifact.body) as unknown; } catch { return refuse(); }
  const publication = ProjectSharedSetupV1Schema.safeParse(document);
  if (!publication.success) return refuse();
  return { sourceId: input.source.id, contentRevision: artifact.revision,
    digest: projectSharedSetupDigestV1(publication.data.manifest), manifest: publication.data.manifest };
}

/** This owner decides content change; the existing preparation owner decides lifecycle consent. */
export function reviewProjectSharedSetupChangeV1(input: Readonly<{
  repositoryManifest: ProjectManifestV1 | null; acceptedSetup: Extract<ProjectSetupReadV1, { kind: 'ready' }>;
  publication: ProjectAcceptedSharedSetupV1;
}>): Extract<ProjectSharedSetupChangeV1, { kind: 'current' }>
  | Omit<Extract<ProjectSharedSetupChangeV1, { kind: 'changed' }>, 'setupReadiness'> {
  const { manifest: _manifest, ...selection } = input.publication;
  const accepted = input.acceptedSetup.acceptedSharedSetup;
  if (accepted && accepted.sourceId === selection.sourceId && accepted.digest === selection.digest
    && accepted.contentRevision.headerVersion === selection.contentRevision.headerVersion
    && accepted.contentRevision.bodyVersion === selection.contentRevision.bodyVersion) return { kind: 'current', selection };
  return { kind: 'changed', selection,
    before: resolveProjectDefinitionV1({ repositoryManifest: input.repositoryManifest, ...input.acceptedSetup }),
    after: resolveProjectDefinitionV1({ repositoryManifest: input.repositoryManifest,
      ...input.acceptedSetup, acceptedSharedSetup: input.publication }) };
}
