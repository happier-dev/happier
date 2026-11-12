import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmHostingProviderRefSchema, ScmPullRequestReferenceSchema, ScmPullRequestStateSchema,
  ScmPullRequestSummarySchema } from './pullRequests.js';
import { ScmHostingRepositoryAuthSummarySchema, ScmHostingRepositoryPublishTargetSchema,
  ScmHostingRepositorySummarySchema, ScmHostingRepositoryOwnerKindSchema,
  ScmHostingRepositoryVisibilitySchema } from './repositoryProvisioning.js';
import { ScmRepositoryCloneRepositorySelectorSchema, ScmRepositoryCloneTargetDescriptionSchema, ScmRepositoryCloneRevisionSchema } from './repositoryClone.js';

const provider = ScmHostingProviderRefSchema;
const listInput = lazyZodSchema(() => z.strictObject({ provider, base: z.optional(z.string()),
  head: z.string(), state: z.optional(ScmPullRequestStateSchema) }));
const referenceInput = lazyZodSchema(() => z.strictObject({ provider, reference: ScmPullRequestReferenceSchema }));
const createPullRequestInput = lazyZodSchema(() => z.strictObject({ provider, base: z.string(), head: z.string(),
  title: z.string(), body: z.optional(z.string()), draft: z.optional(z.boolean()) }));
const checkoutResult = lazyZodSchema(() => z.strictObject({ pullRequest: z.nullable(ScmPullRequestSummarySchema),
  branch: z.optional(z.string()), remoteRef: z.optional(z.string()),
  headSha: z.optional(z.nullable(z.string())), baseSha: z.optional(z.nullable(z.string())) }));
const describePublishInput = lazyZodSchema(() => z.strictObject({ provider, defaultRepositoryName: z.string() }));
const describePublishResult = lazyZodSchema(() => z.strictObject({ auth: ScmHostingRepositoryAuthSummarySchema,
  targets: z.array(ScmHostingRepositoryPublishTargetSchema) }));
const createRepositoryInput = lazyZodSchema(() => z.strictObject({ provider, owner: z.string(),
  ownerKind: z.optional(ScmHostingRepositoryOwnerKindSchema), repositoryName: z.string(),
  visibility: ScmHostingRepositoryVisibilitySchema, description: z.optional(z.string()) }));
const getRepositoryInput = lazyZodSchema(() => z.strictObject({ provider, owner: z.string(), repositoryName: z.string() }));
const cloneInput = lazyZodSchema(() => z.strictObject({ provider, revision: z.optional(ScmRepositoryCloneRevisionSchema), repository: ScmRepositoryCloneRepositorySelectorSchema }));

/** Exact provider method shapes, excluding host capabilities and cancellation handles. */
export const ScmHostingOperationSchemasV1 = {
  listPullRequests: { input: projectZodProtocolSchema(listInput),
    result: projectZodProtocolSchema(lazyZodSchema(() => z.array(ScmPullRequestSummarySchema))) },
  getPullRequest: { input: projectZodProtocolSchema(referenceInput),
    result: projectZodProtocolSchema(lazyZodSchema(() => z.nullable(ScmPullRequestSummarySchema))) },
  createPullRequest: { input: projectZodProtocolSchema(createPullRequestInput),
    result: projectZodProtocolSchema(ScmPullRequestSummarySchema) },
  resolvePullRequestCheckoutReference: { input: projectZodProtocolSchema(referenceInput),
    result: projectZodProtocolSchema(checkoutResult) },
  describePublishTargets: { input: projectZodProtocolSchema(describePublishInput),
    result: projectZodProtocolSchema(describePublishResult) },
  createRepository: { input: projectZodProtocolSchema(createRepositoryInput),
    result: projectZodProtocolSchema(ScmHostingRepositorySummarySchema) },
  getRepository: { input: projectZodProtocolSchema(getRepositoryInput),
    result: projectZodProtocolSchema(lazyZodSchema(() => z.nullable(ScmHostingRepositorySummarySchema))) },
  describeCloneTargets: { input: projectZodProtocolSchema(cloneInput),
    result: projectZodProtocolSchema(ScmRepositoryCloneTargetDescriptionSchema) },
} as const;
