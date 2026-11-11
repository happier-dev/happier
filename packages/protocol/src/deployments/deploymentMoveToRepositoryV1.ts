import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentComposeSelectorsV1Schema, DeploymentStoredDefinitionV1Schema } from './storedAppInputV1.js';
import { ProjectAccountWorkspaceRefKeyV1Schema } from '../projects/workspaceRefKeyV1.js';
import type { ProjectAccountWorkspaceRefKeyV1 } from '../projects/workspaceRefKeyV1.js';
import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import { ProjectSourceRepositorySelectorV1Schema } from '../projects/sources/projectSourceV1.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { ScmHostingRepositoryPublishRequestSchema } from '../scm/repositoryProvisioning.js';
import { ScmRepositoryContainedSubdirV1Schema } from '../scm/repositoryClone.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { ScmPullRequestSummarySchema, ScmPullRequestReferenceSchema } from '../scm/pullRequests.js';
import { ScmRepositoryFilesPullRequestPartialV1Schema } from '../scm/repositoryFilesPullRequest.js';

const pin = lazyZodSchema(() => z.pick(DeploymentStoredDefinitionV1Schema, { contentRevision: true, composeDigest: true }));
const document = lazyZodSchema(() => DeploymentStoredDefinitionV1Schema.shape.document);
const source = lazyZodSchema(() => z.strictObject({ id, revision }));
export const DeploymentMoveToRepositoryCreateRepositoryV1Schema = lazyZodSchema(() => z.strictObject(z.omit(ScmHostingRepositoryPublishRequestSchema,
  { cwd: true, backendPreference: true, outcomeVersion: true }).shape));

export const DeploymentMoveToRepositoryContinuationV1Schema = lazyZodSchema(() => z.strictObject({
  pullRequest: ScmPullRequestSummarySchema, headCommit: ScmCommitOidSchema,
  document, definition: pin, source, path: ScmRepositoryContainedSubdirV1Schema,
  publicFiles: DeploymentStoredDefinitionV1Schema.shape.publicFiles,
  selectors: z.optional(DeploymentComposeSelectorsV1Schema),
}));
export type DeploymentMoveToRepositoryContinuationV1 = z.infer<typeof DeploymentMoveToRepositoryContinuationV1Schema>;

/** Explicit acceptance of the actual merged bytes against the current stored content. */
export const DeploymentMoveToRepositoryMergedReviewV1Schema = lazyZodSchema(() => z.strictObject({
  currentDefinition: pin, currentDocument: document,
  mergedCommit: ScmCommitOidSchema, mergedDocument: document,
  currentPublicFiles: DeploymentStoredDefinitionV1Schema.shape.publicFiles,
  mergedPublicFiles: DeploymentStoredDefinitionV1Schema.shape.publicFiles,
}));
export type DeploymentMoveToRepositoryMergedReviewV1 = z.infer<typeof DeploymentMoveToRepositoryMergedReviewV1Schema>;

export const DeploymentMoveToRepositoryInputV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.enum(['preview', 'apply']), serverId: id, environmentId: id,
  definition: pin, path: ScmRepositoryContainedSubdirV1Schema,
  repository: z.optional(ScmHostingRepositoryIdentityV1Schema), createRepository: z.optional(DeploymentMoveToRepositoryCreateRepositoryV1Schema),
  sourceRepository: z.optional(ProjectSourceRepositorySelectorV1Schema),
  baseCommit: z.optional(ScmCommitOidSchema), baseBranch: z.optional(id), workspace: ProjectAccountWorkspaceRefKeyV1Schema,
  selectors: z.optional(DeploymentComposeSelectorsV1Schema),
  continuation: z.optional(DeploymentMoveToRepositoryContinuationV1Schema),
  pullRequestReference: z.optional(ScmPullRequestReferenceSchema),
  repositoryWork: z.optional(ScmRepositoryFilesPullRequestPartialV1Schema),
  useMergedVersion: z.optional(DeploymentMoveToRepositoryMergedReviewV1Schema),
}).check(z.superRefine((input, context) => {
  if ((input.repository === undefined) === (input.createRepository === undefined))
    context.addIssue({ code: 'custom', path: ['repository'], message: 'Choose one existing repository or create a repository.' });
  if (input.repository && (!input.baseCommit || !input.baseBranch))
    context.addIssue({ code: 'custom', path: ['workspace'], message: 'An existing repository needs its workspace and exact base.' });
  if (input.continuation && input.pullRequestReference)
    context.addIssue({ code: 'custom', path: ['pullRequestReference'], message: 'Choose the captured continuation or an existing pull request.' });
  if (input.useMergedVersion && !input.continuation && !input.pullRequestReference)
    context.addIssue({ code: 'custom', path: ['continuation'], message: 'Merged content acceptance retains the original pull request.' });
})));
export type DeploymentMoveToRepositoryInputV1 = z.infer<typeof DeploymentMoveToRepositoryInputV1Schema>;

/** The person's selected admitted WorkspaceRef owns repository execution placement. */
export function resolveDeploymentMoveToRepositoryExecutionMachineIdV1(
  input: DeploymentMoveToRepositoryInputV1,
  readWorkspaceMachine: (workspace: ProjectAccountWorkspaceRefKeyV1) => Promise<Readonly<{ ok: true; machineId: string }> | ActionExecuteFailure>,
): Promise<Readonly<{ ok: true; machineId: string }> | ActionExecuteFailure> {
  return readWorkspaceMachine(input.workspace);
}

export const DeploymentMoveToRepositoryReviewV1Schema = lazyZodSchema(() => z.strictObject({
  document, repository: ScmHostingRepositoryIdentityV1Schema, path: ScmRepositoryContainedSubdirV1Schema,
  baseCommit: ScmCommitOidSchema, baseBranch: id, workspace: ProjectAccountWorkspaceRefKeyV1Schema,
  source, before: z.nullable(z.string()), selectors: z.optional(DeploymentComposeSelectorsV1Schema),
  files: z.optional(z.array(z.strictObject({ path: ScmRepositoryContainedSubdirV1Schema, before: z.nullable(z.string()), content: z.string() }))),
}));
export type DeploymentMoveToRepositoryReviewV1 = z.infer<typeof DeploymentMoveToRepositoryReviewV1Schema>;

export const DeploymentMoveToRepositoryResolvedRepositoryV1Schema = lazyZodSchema(() => z.strictObject({
  repository: ScmHostingRepositoryIdentityV1Schema, baseCommit: ScmCommitOidSchema,
  baseBranch: id, workspace: ProjectAccountWorkspaceRefKeyV1Schema,
}));

export const DeploymentMoveToRepositoryResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preview'), review: DeploymentMoveToRepositoryReviewV1Schema }),
  z.strictObject({ kind: z.literal('previewCreate'), review: z.strictObject({
    document, path: ScmRepositoryContainedSubdirV1Schema, workspace: ProjectAccountWorkspaceRefKeyV1Schema,
    createRepository: DeploymentMoveToRepositoryCreateRepositoryV1Schema, selectors: z.optional(DeploymentComposeSelectorsV1Schema),
    files: z.optional(z.array(z.strictObject({ path: ScmRepositoryContainedSubdirV1Schema, before: z.nullable(z.string()), content: z.string() }))),
  }) }),
  z.strictObject({ kind: z.literal('pullRequest'), continuation: DeploymentMoveToRepositoryContinuationV1Schema,
    repository: z.optional(DeploymentMoveToRepositoryResolvedRepositoryV1Schema) }),
  z.strictObject({ kind: z.literal('pullRequestStatus'), pullRequest: ScmPullRequestSummarySchema }),
  z.strictObject({ kind: z.literal('reviewMerged'), review: DeploymentMoveToRepositoryMergedReviewV1Schema,
    continuation: z.optional(DeploymentMoveToRepositoryContinuationV1Schema), pullRequest: z.optional(ScmPullRequestSummarySchema) }),
  z.strictObject({ kind: z.literal('switched'), environmentId: id, revision, commitSha: ScmCommitOidSchema }),
  z.strictObject({ kind: z.literal('partial'), errorCode: id, phase: id,
    repositoryWork: z.optional(ScmRepositoryFilesPullRequestPartialV1Schema), continuation: z.optional(DeploymentMoveToRepositoryContinuationV1Schema) }),
  z.strictObject({ kind: z.enum(['refused', 'conflict']), reason: id,
    continuation: z.optional(DeploymentMoveToRepositoryContinuationV1Schema) }),
]));
export type DeploymentMoveToRepositoryResultV1 = z.infer<typeof DeploymentMoveToRepositoryResultV1Schema>;
