import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { ProjectAccountWorkspaceRefKeyV1Schema } from '../projects/workspaceRefKeyV1.js';
import { ActionSessionAddressV1Schema } from '../actions/sessionAddressV1.js';
import { ActionOperationAddressV1Schema } from '../actions/operations/addressV1.js';

/** Source/base/workspace intent only. The authenticated host resolves Account and placement. */
export const DeploymentPrepareInputV1Schema = lazyZodSchema(() => z.strictObject({
  projectSourceId: id, sourceRevision: revision, repository: ScmHostingRepositoryIdentityV1Schema,
  baseCommit: ScmCommitOidSchema, workspace: ProjectAccountWorkspaceRefKeyV1Schema,
  target: z.optional(z.strictObject({ environmentId: id, targetLinkId: id, expectedTargetLinkRevision: revision })),
  environmentId: z.optional(id),
  sessionRef: z.optional(ActionSessionAddressV1Schema),
  // References only: the Session's normal workspace tools inspect the files.
  importFrom: z.optional(z.strictObject({
    tool: z.string().check(z.trim(), z.minLength(1)),
    configurationPaths: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  })),
}).check(z.refine(input => input.environmentId === undefined || input.target === undefined
  || input.environmentId === input.target.environmentId, { message: 'The selected target belongs to the reviewed Environment.' })));
export type DeploymentPrepareInputV1 = z.infer<typeof DeploymentPrepareInputV1Schema>;

export const DeploymentPreparationRefusalV1Schema = lazyZodSchema(() => z.enum([
  'unavailable', 'access_denied', 'source_changed', 'base_changed', 'workspace_unavailable',
  'target_unavailable', 'input_changed', 'child_failed', 'cancelled',
]));
export const DeploymentPrepareResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('handedOff'), sessionRef: ActionSessionAddressV1Schema,
    childOperationRefs: z.optional(z.array(ActionOperationAddressV1Schema)) }),
  z.strictObject({ kind: z.literal('partial'), sessionRef: z.optional(ActionSessionAddressV1Schema),
    childOperationRefs: z.array(ActionOperationAddressV1Schema), reason: DeploymentPreparationRefusalV1Schema }),
  z.strictObject({ kind: z.enum(['conflict', 'refused']), reason: DeploymentPreparationRefusalV1Schema }),
]));
export type DeploymentPrepareResultV1 = z.infer<typeof DeploymentPrepareResultV1Schema>;

/** Parent/child receipts remain owned by the existing Workflow and Action operation owners. */
export const DeploymentPublishResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), operationRef: ActionOperationAddressV1Schema,
    childOperationRefs: z.optional(z.array(ActionOperationAddressV1Schema)) }),
  z.strictObject({ kind: z.literal('partial'), operationRef: z.optional(ActionOperationAddressV1Schema),
    childOperationRefs: z.array(ActionOperationAddressV1Schema), reason: DeploymentPreparationRefusalV1Schema }),
  z.strictObject({ kind: z.enum(['conflict', 'refused']), reason: DeploymentPreparationRefusalV1Schema }),
]));
export type DeploymentPublishResultV1 = z.infer<typeof DeploymentPublishResultV1Schema>;
