import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ScmRepositoryCloneInputSchema } from '../../scm/repositoryClone.js';
import { ScmRepositoryProvisioningRemediationSchema } from '../../scm/repositoryProvisioning.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
export const ProjectStarterCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: text(), machineId: text(), requestKey: text(), starterId: text(),
  // Keep the person's first message byte-for-byte, including formatting.
  description: z.string().check(z.refine(value => value.trim().length > 0)),
  destinationParentPath: ScmRepositoryCloneInputSchema.shape.destinationParentPath,
  destinationDirectoryName: ScmRepositoryCloneInputSchema.shape.destinationDirectoryName,
  repository: z.strictObject({ owner: text(), name: text(), visibility: z._default(z.enum(['private', 'public']), 'private') }),
}));
export type ProjectStarterCreateInputV1 = z.infer<typeof ProjectStarterCreateInputV1Schema>;
export const ProjectStarterCreateOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('created'), projectId: text(), sourceId: text(), repositoryUrl: z.string().check(z.url()),
    starterId: text(), commit: text(), workspace: WorkspaceAddressV1Schema,
    sessionHandoff: z.strictObject({ machineId: text(), directory: text(), initialMessage: z.string() }) }),
  z.strictObject({ kind: z.enum(['failed', 'partial']), phase: z.enum(['starter', 'account', 'checkout', 'publish', 'source', 'project']),
    code: text(), directory: z.optional(text()), repositoryUrl: z.optional(z.string().check(z.url())), sourceId: z.optional(text()),
    workspace: z.optional(WorkspaceAddressV1Schema), remediation: z.optional(ScmRepositoryProvisioningRemediationSchema) }),
]));
export type ProjectStarterCreateOutputV1 = z.infer<typeof ProjectStarterCreateOutputV1Schema>;
