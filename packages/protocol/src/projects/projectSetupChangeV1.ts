import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectEffectiveDefinitionV1Schema, resolveProjectDefinitionV1, createProjectDefinitionOriginLookupV1, type ProjectEffectiveDefinitionV1, type ProjectDefinitionOriginV1 } from '../workspaces/projectSetup/projectDefinitionCompositionV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import type { ProjectManifestV1, ProjectCommandSourceV1 } from '../workspaces/projectSetup/projectManifestV1.js';
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

type ProjectDeclarationChangeV1<T> =
  | Readonly<{ op: 'added'; after: T }>
  | Readonly<{ op: 'removed'; before: T }>
  | Readonly<{ op: 'changed'; before: T; after: T }>;
type ProjectChangeRowV1<Entry extends string, Value> = Readonly<{
  entry: Entry; key: string;
  origin: Readonly<{ before: ProjectDefinitionOriginV1 | null; after: ProjectDefinitionOriginV1 | null }>;
}> & ProjectDeclarationChangeV1<Value>;

/** Declaration edits only: captured login bytes and lifecycle consent remain preparation-owned. */
export type ProjectSharedSetupChangeRowV1 =
  | (ProjectChangeRowV1<'step', ProjectCommandSourceV1> & Readonly<{ phase: 'setup' | 'teardown' }>)
  | ProjectChangeRowV1<'login', NonNullable<ProjectManifestV1['toolchain']>>
  | ProjectChangeRowV1<'input', readonly string[]>
  | ProjectChangeRowV1<'tool', NonNullable<ProjectManifestV1['devcontainer']>>
  | ProjectChangeRowV1<'env', NonNullable<ProjectManifestV1['environmentVariables']>[number]>
  | ProjectChangeRowV1<'ports', NonNullable<ProjectManifestV1['worktreePorts']>>
  | ProjectChangeRowV1<'script', NonNullable<ProjectManifestV1['scripts']>[string]>
  | ProjectChangeRowV1<'service', NonNullable<ProjectManifestV1['services']>[string]>;

function declarationChange<T>(before: T | undefined, after: T | undefined): ProjectDeclarationChangeV1<T> | null {
  if (before === undefined) return after === undefined ? null : { op: 'added', after };
  if (after === undefined) return { op: 'removed', before };
  return createCanonicalJsonSigningInput(before) === createCanonicalJsonSigningInput(after)
    ? null : { op: 'changed', before, after };
}

function namedDeclarations<T>(before: Iterable<readonly [string, T]>, after: Iterable<readonly [string, T]>) {
  const previous = new Map(before);
  const next = new Map(after);
  return [...new Set([...previous.keys(), ...next.keys()])].sort().map(key => ({
    key, before: previous.get(key), after: next.get(key),
  }));
}

/**
 * Project the review owner's effective values; never compare raw publication layers in a consumer.
 * Ordered setup/teardown commands use their position. Named declarations use their identity.
 * Origins and publication revisions alone produce no rows. Ports describe declarations, never
 * assigned values. These rows do not decide whether consent changed or reconstruct login bytes.
 */
export function projectSharedSetupChangeRowsV1(
  before: ProjectEffectiveDefinitionV1, after: ProjectEffectiveDefinitionV1,
): readonly ProjectSharedSetupChangeRowV1[] {
  const rows: ProjectSharedSetupChangeRowV1[] = [];
  const previous = before.effectiveManifest;
  const next = after.effectiveManifest;
  const previousOrigin = createProjectDefinitionOriginLookupV1(before);
  const nextOrigin = createProjectDefinitionOriginLookupV1(after);
  const origin = (path: readonly string[]) => ({ before: previousOrigin(path), after: nextOrigin(path) });
  for (const phase of ['setup', 'teardown'] as const) {
    const previousCommands = previous?.workspace?.[phase] ?? [];
    const nextCommands = next?.workspace?.[phase] ?? [];
    for (let index = 0; index < Math.max(previousCommands.length, nextCommands.length); index++) {
      const change = declarationChange(previousCommands[index], nextCommands[index]);
      if (change) rows.push({ entry: 'step', phase, key: `${phase}:${index}`, ...change, origin: origin(['workspace', phase]) });
    }
  }
  const login = declarationChange(previous?.toolchain, next?.toolchain);
  if (login) rows.push({ entry: 'login', key: 'toolchain', ...login, origin: origin(['toolchain']) });
  const previousInputs = previous?.workspace?.setupInputs;
  const nextInputs = next?.workspace?.setupInputs;
  const inputs = declarationChange(previousInputs?.length ? previousInputs : undefined, nextInputs?.length ? nextInputs : undefined);
  if (inputs) rows.push({ entry: 'input', key: 'setupInputs', ...inputs, origin: origin(['workspace', 'setupInputs']) });
  const tool = declarationChange(previous?.devcontainer, next?.devcontainer);
  if (tool) rows.push({ entry: 'tool', key: 'devcontainer', ...tool, origin: origin(['devcontainer']) });
  for (const declaration of namedDeclarations(
    (previous?.environmentVariables ?? []).map(value => [value.name, value] as const),
    (next?.environmentVariables ?? []).map(value => [value.name, value] as const),
  )) {
    const change = declarationChange(declaration.before, declaration.after);
    if (change) rows.push({ entry: 'env', key: declaration.key, ...change, origin: origin(['environmentVariables', declaration.key]) });
  }
  const ports = declarationChange(previous?.worktreePorts, next?.worktreePorts);
  if (ports) rows.push({ entry: 'ports', key: 'worktreePorts', ...ports, origin: origin(['worktreePorts']) });
  for (const declaration of namedDeclarations(Object.entries(previous?.scripts ?? {}), Object.entries(next?.scripts ?? {}))) {
    const change = declarationChange(declaration.before, declaration.after);
    if (change) rows.push({ entry: 'script', key: declaration.key, ...change, origin: origin(['scripts', declaration.key]) });
  }
  for (const declaration of namedDeclarations(Object.entries(previous?.services ?? {}), Object.entries(next?.services ?? {}))) {
    const change = declarationChange(declaration.before, declaration.after);
    if (change) rows.push({ entry: 'service', key: declaration.key, ...change, origin: origin(['services', declaration.key]) });
  }
  return rows;
}
