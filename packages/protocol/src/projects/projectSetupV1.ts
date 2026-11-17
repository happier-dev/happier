import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectSourceAudienceTeamV1Schema } from './sources/projectSourceIdentityV1.js';
import { ProjectManifestV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import { encodeArtifactKindV1 } from '../artifacts/artifactKindV1.js';
import { computeSha256HexDigest } from '../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactRevisionV1.js';
import type { ArtifactBodyV1 } from '../artifacts/artifactBinaryV1.js';
import { readActionErrorCodeV1, projectActionFailureCauseV1, type ActionFailureCauseV1 } from '../actions/actionExecutionResult.js';

export const PROJECT_SETUP_ARTIFACT_KIND_V1 = 'project_setup.v1' as const;
export const PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 = encodeArtifactKindV1({ kind: 'other', kindHint: PROJECT_SETUP_ARTIFACT_KIND_V1 });
const id = z.string().check(z.minLength(1));
export const ProjectSetupContentRevisionV1Schema = ArtifactRevisionV1Schema;
export const ProjectSetupSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  sourceId: id, contentRevision: ProjectSetupContentRevisionV1Schema, digest: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
}));
export type ProjectSetupSelectionV1 = z.infer<typeof ProjectSetupSelectionV1Schema>;
/** Keep presentation and manifest fields outside the admitted effect identity. */
export function projectSetupSelectionV1(value: ProjectSetupSelectionV1): ProjectSetupSelectionV1 {
  return { sourceId: value.sourceId, contentRevision: value.contentRevision, digest: value.digest };
}
export const ProjectAcceptedSharedSetupV1Schema = lazyZodSchema(() => z.extend(ProjectSetupSelectionV1Schema, {
  manifest: ProjectManifestV1Schema,
  /** Snapshot retained with accepted content; never part of the effect selection or digest. */
  sourceAudienceTeams: z.optional(z.array(ProjectSourceAudienceTeamV1Schema)),
}));
export type ProjectAcceptedSharedSetupV1 = z.infer<typeof ProjectAcceptedSharedSetupV1Schema>;
/** One protected detail address; census never embeds executable declarations. */
export const ProjectSetupContentRefV1Schema = lazyZodSchema(() => z.strictObject({ artifactId: id, ...ProjectSetupContentRevisionV1Schema.shape }));
export type ProjectSetupContentRefV1 = z.infer<typeof ProjectSetupContentRefV1Schema>;
export const ProjectSharedSetupV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal(PROJECT_SETUP_ARTIFACT_KIND_V1), manifest: ProjectManifestV1Schema }));
export const ProjectSetupContentV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(PROJECT_SETUP_ARTIFACT_KIND_V1), acceptedSharedSetup: z.optional(ProjectAcceptedSharedSetupV1Schema),
  setupOverrides: z.optional(ProjectManifestV1Schema),
}));
export type ProjectSetupContentV1 = z.infer<typeof ProjectSetupContentV1Schema>;
export function projectSharedSetupDigestV1(manifest: z.infer<typeof ProjectManifestV1Schema>): string {
  return computeSha256HexDigest(createCanonicalJsonSigningInput(ProjectManifestV1Schema.parse(manifest)));
}

export type ProjectSetupArtifactV1 = Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; body: ArtifactBodyV1 | null;
  revision: z.infer<typeof ArtifactRevisionV1Schema>;
}>;
export type ProjectSetupReadV1 = Readonly<{ kind: 'ready' } & Omit<ProjectSetupContentV1, 'kind'>>
  | Readonly<{ kind: 'unavailable'; code: string; failureCause?: ActionFailureCauseV1 }>;

/** One selected-detail boundary shared by editors and preparation; publisher access is not an input. */
export async function readAcceptedProjectSetupV1(input: Readonly<{
  setupContent?: ProjectSetupContentRefV1; setupSelection?: ProjectSetupSelectionV1; signal?: AbortSignal;
  readArtifact(artifactId: string): Promise<ProjectSetupArtifactV1 | null>;
}>): Promise<ProjectSetupReadV1> {
  const unavailable = { kind: 'unavailable', code: 'project_setup_review_unavailable' } as const;
  const pointer = input.setupContent;
  if (!pointer) return input.setupSelection ? unavailable : { kind: 'ready' };
  let artifact: ProjectSetupArtifactV1 | null;
  try {
    input.signal?.throwIfAborted();
    artifact = await input.readArtifact(pointer.artifactId);
    input.signal?.throwIfAborted();
  } catch (error) {
    input.signal?.throwIfAborted();
    return { kind: 'unavailable', code: readActionErrorCodeV1(error) ?? 'action_failed',
      failureCause: projectActionFailureCauseV1(error, 'projects.setup.read') };
  }
  if (!artifact || artifact.artifactId !== pointer.artifactId || artifact.header.kind !== PROJECT_SETUP_ARTIFACT_KIND_V1
    || artifact.revision.headerVersion !== pointer.headerVersion || artifact.revision.bodyVersion !== pointer.bodyVersion
    || typeof artifact.body !== 'string') return unavailable;
  let body: unknown;
  try { body = JSON.parse(artifact.body) as unknown; } catch { return unavailable; }
  const parsed = ProjectSetupContentV1Schema.safeParse(body);
  if (!parsed.success) return unavailable;
  const accepted = parsed.data.acceptedSharedSetup;
  const selection = input.setupSelection;
  if (Boolean(accepted) !== Boolean(selection) || accepted && selection && (accepted.sourceId !== selection.sourceId
    || accepted.digest !== selection.digest || accepted.contentRevision.headerVersion !== selection.contentRevision.headerVersion
    || accepted.contentRevision.bodyVersion !== selection.contentRevision.bodyVersion
    || projectSharedSetupDigestV1(accepted.manifest) !== accepted.digest)) return unavailable;
  return { ...parsed.data, kind: 'ready' };
}
