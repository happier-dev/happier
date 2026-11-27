import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectEffectiveDefinitionV1Schema, resolveProjectDefinitionV1 } from '../workspaces/projectSetup/projectDefinitionCompositionV1.js';
import type { ProjectManifestV1 } from '../workspaces/projectSetup/projectManifestV1.js';
import { ProjectSetupReviewV1Schema, ProjectSetupReadinessV1Schema } from '../actions/projectSetupConsentFailure.js';
import { ActionFailureCauseV1Schema, createActionExecuteFailureError } from '../actions/actionExecutionResult.js';
import { ProjectSetupContentRevisionV1Schema, ProjectSetupPublicationAttributionV1Schema, ProjectSetupSelectionV1Schema, ProjectSharedSetupV1Schema,
  PROJECT_SETUP_ARTIFACT_KIND_V1, PROJECT_SETUP_REVIEW_UNAVAILABLE_V1, projectSetupSelectionV1, projectSharedSetupDigestV1, type ProjectAcceptedSharedSetupV1,
  type ProjectSetupArtifactV1, type ProjectSetupPublicationAttributionV1, type ProjectSetupReadV1 } from './projectSetupV1.js';
import type { ProjectSourceV1, ProjectSourcesReadInputV1, ProjectSourcesReadOutputV1 } from './sources/projectSourceV1.js';
import { ProjectSourceAudienceTeamV1Schema } from './sources/projectSourceIdentityV1.js';
import { EnvVarRequirementSchema } from '../profiles/environmentVariables.js';

/** A demanded publication-change review; launch continues to use accepted content. */
export const ProjectSharedSetupChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current'), selection: ProjectSetupSelectionV1Schema,
    ...ProjectSetupPublicationAttributionV1Schema.shape,
    sourceAudienceTeams: z.optional(z.array(ProjectSourceAudienceTeamV1Schema)) }),
  z.strictObject({ kind: z.literal('changed'), selection: ProjectSetupSelectionV1Schema,
    ...ProjectSetupPublicationAttributionV1Schema.shape,
    sourceAudienceTeams: z.optional(z.array(ProjectSourceAudienceTeamV1Schema)),
    before: ProjectEffectiveDefinitionV1Schema, after: ProjectEffectiveDefinitionV1Schema,
    setupReadiness: ProjectSetupReadinessV1Schema,
    setupReview: z.optional(ProjectSetupReviewV1Schema) }),
  z.strictObject({ kind: z.literal('upstreamUnavailable'), code: z.string().check(z.minLength(1)),
    failureCause: z.optional(ActionFailureCauseV1Schema) }),
]));
export type ProjectSharedSetupChangeV1 = z.infer<typeof ProjectSharedSetupChangeV1Schema>;

type PublishedSetupReadV1 = Readonly<{
  source: ProjectSourceV1; readArtifact(artifactId: string, projectSourceId: string): Promise<ProjectSetupArtifactV1 | null>;
}>;
const refusePublication = (): never => {
  const code = PROJECT_SETUP_REVIEW_UNAVAILABLE_V1;
  throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code });
};

/** Publication admission is shared by requirements, acceptance and update review. */
async function readPublishedSetupManifestV1(input: PublishedSetupReadV1) {
  const attachment = input.source.attachments?.find(value => value.purpose === 'setup');
  if (!attachment) return null;
  if (attachment.ref.kind !== 'doc') return refusePublication();
  const artifact = await input.readArtifact(attachment.ref.artifactId, input.source.id);
  if (!artifact || artifact.artifactId !== attachment.ref.artifactId || artifact.header.kind !== PROJECT_SETUP_ARTIFACT_KIND_V1
    || typeof artifact.body !== 'string' || artifact.revision.headerVersion !== attachment.contentRevision.headerVersion
    || artifact.revision.bodyVersion !== attachment.contentRevision.bodyVersion) return refusePublication();
  let document: unknown;
  try { document = JSON.parse(artifact.body) as unknown; } catch { return refusePublication(); }
  const publication = ProjectSharedSetupV1Schema.safeParse(document);
  if (!publication.success) return refusePublication();
  return { sourceId: input.source.id, contentRevision: artifact.revision, manifest: publication.data.manifest,
    ...publicationAttribution(attachment) };
}

function publicationAttribution({ publishedBy, publishedAt }: ProjectSetupPublicationAttributionV1): ProjectSetupPublicationAttributionV1 {
  return publishedBy && publishedAt !== undefined ? { publishedBy, publishedAt } : {};
}

export type PublishedProjectSetupV1 = ProjectAcceptedSharedSetupV1 & ProjectSetupPublicationAttributionV1;

export async function readPublishedProjectSetupV1(input: PublishedSetupReadV1): Promise<PublishedProjectSetupV1> {
  const publication = await readPublishedSetupManifestV1(input);
  if (!publication) return refusePublication();
  return { ...publication, digest: projectSharedSetupDigestV1(publication.manifest),
    ...(input.source.audienceTeams ? { sourceAudienceTeams: input.source.audienceTeams } : {}) };
}

export const SourceSetupRequirementsV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unpublished') }),
  z.strictObject({
    kind: z.literal('published'),
    names: z.array(EnvVarRequirementSchema.shape.name),
    provenance: z.strictObject({
      layer: z.literal('shared'), sourceId: z.string().check(z.minLength(1)),
      contentRevision: ProjectSetupContentRevisionV1Schema,
    }),
  }),
]));
export type SourceSetupRequirementsV1 = z.infer<typeof SourceSetupRequirementsV1Schema>;

export async function readSourceSetupRequirementsV1(
  input: ProjectSourcesReadInputV1,
  deps: Readonly<{
    readSource(input: ProjectSourcesReadInputV1): Promise<ProjectSourcesReadOutputV1>;
    readArtifact: PublishedSetupReadV1['readArtifact'];
  }>,
): Promise<SourceSetupRequirementsV1> {
  const source = await deps.readSource(input);
  if (!source.ok) throw createActionExecuteFailureError({ ok: false, errorCode: source.error, error: source.error });
  const publication = await readPublishedSetupManifestV1({ source: source.source, readArtifact: deps.readArtifact });
  if (!publication) return { kind: 'unpublished' };
  return {
    kind: 'published',
    names: (publication.manifest.environmentVariables ?? []).map(requirement => requirement.name),
    provenance: { layer: 'shared', sourceId: publication.sourceId, contentRevision: publication.contentRevision },
  };
}

export type ProjectSharedSetupComparisonV1 = Pick<
  Exclude<ProjectSharedSetupChangeV1, { kind: 'upstreamUnavailable' }>,
  'kind' | 'selection' | 'sourceAudienceTeams' | 'publishedBy' | 'publishedAt'
>;

/** One publication-currentness decision for pending inspection and explicit review. */
export function compareProjectSharedSetupV1(input: Readonly<{
  acceptedSetup: Extract<ProjectSetupReadV1, { kind: 'ready' }>; publication: PublishedProjectSetupV1;
}>): ProjectSharedSetupComparisonV1 {
  const selection = projectSetupSelectionV1(input.publication);
  const presentation = { ...publicationAttribution(input.publication),
    ...(input.publication.sourceAudienceTeams ? { sourceAudienceTeams: input.publication.sourceAudienceTeams } : {}) };
  const accepted = input.acceptedSetup.acceptedSharedSetup;
  if (accepted && accepted.sourceId === selection.sourceId && accepted.digest === selection.digest
    && accepted.contentRevision.headerVersion === selection.contentRevision.headerVersion
    && accepted.contentRevision.bodyVersion === selection.contentRevision.bodyVersion) return { kind: 'current', selection, ...presentation };
  return { kind: 'changed', selection, ...presentation };
}

/** The existing preparation owner decides lifecycle consent after this comparison. */
export function reviewProjectSharedSetupChangeV1(input: Readonly<{
  repositoryManifest: ProjectManifestV1 | null; acceptedSetup: Extract<ProjectSetupReadV1, { kind: 'ready' }>;
  publication: PublishedProjectSetupV1; comparison?: ProjectSharedSetupComparisonV1;
}>): Extract<ProjectSharedSetupChangeV1, { kind: 'current' }>
  | Omit<Extract<ProjectSharedSetupChangeV1, { kind: 'changed' }>, 'setupReadiness'> {
  const comparison = input.comparison ?? compareProjectSharedSetupV1(input);
  if (comparison.kind === 'current') return { ...comparison, kind: 'current' };
  return { ...comparison, kind: 'changed',
    before: resolveProjectDefinitionV1({ repositoryManifest: input.repositoryManifest, ...input.acceptedSetup }),
    after: resolveProjectDefinitionV1({ repositoryManifest: input.repositoryManifest,
      ...input.acceptedSetup, acceptedSharedSetup: input.publication }) };
}
