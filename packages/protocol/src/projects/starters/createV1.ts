import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ScmRepositoryCloneInputSchema } from '../../scm/repositoryClone.js';
import { ScmHostingRepositoryDescribePublishTargetsRequestSchema, ScmHostingRepositoryPublishRequestSchema, ScmRepositoryProvisioningRemediationSchema } from '../../scm/repositoryProvisioning.js';
import { ScmHostingProviderKindSchema } from '../../scm/pullRequests.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';
import { ProjectSourceRepositorySelectorV1Schema } from '../sources/projectSourceV1.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
export const DEFAULT_PROJECT_REPOSITORY_PROVIDER_KIND_V1 = 'github' as const;
/** Existing effects for a visible retry; the commit remains informational. */
export const ProjectStarterCreateResumeV1Schema = lazyZodSchema(() => z.strictObject({
  directory: ScmRepositoryCloneInputSchema.shape.destinationParentPath,
  repositoryUrl: z.string().check(z.url()), repository: ProjectSourceRepositorySelectorV1Schema,
  commit: z.optional(text()), sourceId: z.optional(text()),
}));
export type ProjectStarterCreateResumeV1 = z.infer<typeof ProjectStarterCreateResumeV1Schema>;
export const ProjectStarterCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: text(), machineId: text(), requestKey: text(), starterId: z.optional(text()),
  source: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('starter'), starterId: text(), sourceId: z.optional(text()) }),
    z.strictObject({ kind: z.literal('scratch') }),
  ])),
  /** Exact registry provenance when the starter was selected from a catalog snapshot. */
  starterSourceId: z.optional(text()),
  resume: z.optional(ProjectStarterCreateResumeV1Schema),
  // Keep the person's first message byte-for-byte, including formatting.
  description: z.string().check(z.refine(value => value.trim().length > 0)),
  destinationParentPath: ScmRepositoryCloneInputSchema.shape.destinationParentPath,
  destinationDirectoryName: ScmRepositoryCloneInputSchema.shape.destinationDirectoryName,
  repository: z.strictObject({ providerKind: z._default(ScmHostingProviderKindSchema, DEFAULT_PROJECT_REPOSITORY_PROVIDER_KIND_V1),
    providerId: ScmHostingRepositoryDescribePublishTargetsRequestSchema.shape.providerId,
    providerBaseUrl: ScmHostingRepositoryPublishRequestSchema.shape.providerBaseUrl,
    owner: text(), name: text(), visibility: z._default(z.enum(['private', 'public']), 'private') }),
}).check(z.refine(input => input.source !== undefined || input.starterId !== undefined, {
  path: ['source'], message: 'Choose a starter or scratch source',
})));
export type ProjectStarterCreateInputV1 = z.infer<typeof ProjectStarterCreateInputV1Schema>;
export const ProjectStarterCreateOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('created'), projectId: text(), sourceId: text(), repositoryUrl: z.string().check(z.url()),
    starterId: z.optional(text()), commit: z.optional(text()), workspace: WorkspaceAddressV1Schema,
    sessionHandoff: z.strictObject({ machineId: text(), directory: text(), initialMessage: z.string() }) }),
  z.strictObject({ kind: z.enum(['failed', 'partial']), phase: z.enum(['starter', 'account', 'checkout', 'publish', 'source', 'project']),
    code: text(), directory: z.optional(text()), repositoryUrl: z.optional(z.string().check(z.url())), sourceId: z.optional(text()),
    workspace: z.optional(WorkspaceAddressV1Schema), resume: z.optional(ProjectStarterCreateResumeV1Schema), remediation: z.optional(ScmRepositoryProvisioningRemediationSchema) }),
]));
export type ProjectStarterCreateOutputV1 = z.infer<typeof ProjectStarterCreateOutputV1Schema>;
