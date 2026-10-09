import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ScmRepositoryCloneInputSchema, ScmRepositoryContainedSubdirV1Schema } from '../scm/repositoryClone.js';
import { SessionAuthoringCheckoutCreationDraftV1Schema } from '../sessions/authoring/creationFieldsV1.js';
import { HandoffWorkspaceActionV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { WorkspaceAddressV1Schema, WorkspaceRefV1WriteSchema, WorkspaceProjectFactsV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectSourceRepositorySelectorV1Schema } from './sources/projectSourceV1.js';

const IdSchema = lazyZodSchema(() => z.string().trim().min(1));
const PathSchema = lazyZodSchema(() => z.string().trim().min(1).refine(value => !value.includes('\0')));

/** Closed choices consumed by the incumbent SCM and Sync realization owners. */
export const WorkspaceActivationRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attach') }).strict(),
  z.object({
    kind: z.literal('worktree'),
    checkout: SessionAuthoringCheckoutCreationDraftV1Schema,
    targetPath: PathSchema.optional(),
  }).strict(),
  ScmRepositoryCloneInputSchema.pick({ destinationParentPath: true, destinationDirectoryName: true }).extend({
    kind: z.literal('clone'),
  }).strict(),
  z.object({
    kind: z.literal('sync'),
    targetPath: PathSchema,
    workspaceAction: HandoffWorkspaceActionV1Schema.refine(action => action.kind !== 'none'),
  }).strict(),
]));
export type WorkspaceActivationRequestV1 = z.infer<typeof WorkspaceActivationRequestV1Schema>;

export const OpenProjectInputV1Schema = lazyZodSchema(() => z.object({
  serverId: IdSchema,
  machineId: IdSchema,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace'), workspaceId: IdSchema, checkout: WorkspaceAddressV1Schema.optional() }).strict(),
    z.object({ kind: z.literal('folder'), path: PathSchema }).strict(),
    z.object({
      kind: z.literal('source'), id: IdSchema, revision: z.number().int().positive(),
      selector: ProjectSourceRepositorySelectorV1Schema,
      defaultRef: IdSchema.optional(), subdir: ScmRepositoryContainedSubdirV1Schema.optional(),
      checkout: WorkspaceAddressV1Schema.optional(),
    }).strict(),
    z.object({ kind: z.literal('repository'), selector: ProjectSourceRepositorySelectorV1Schema }).strict(),
  ]),
  ref: IdSchema.optional(),
  subdir: ScmRepositoryContainedSubdirV1Schema.optional(),
  materialization: WorkspaceActivationRequestV1Schema,
}).strict().superRefine((input, context) => {
  if ((input.source.kind === 'workspace' || input.source.kind === 'source') && input.source.checkout) {
    if (input.source.checkout.serverId !== input.serverId
      || input.source.kind === 'workspace' && input.source.checkout.workspaceId !== input.source.workspaceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'checkout'], message: 'Checkout must match the selected Home and Workspace' });
    }
  }
}));
export type OpenProjectInputV1 = z.infer<typeof OpenProjectInputV1Schema>;

export const OpenProjectResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('opened'), workspace: WorkspaceAddressV1Schema, directory: PathSchema,
    setup: z.enum(['notRequired', 'approvalRequired', 'prepared', 'failed']),
    facts: WorkspaceProjectFactsV1Schema.optional(),
  }).strict(),
  z.object({ kind: z.literal('ambiguous'), candidates: z.array(WorkspaceRefV1WriteSchema) }).strict(),
  z.object({ kind: z.literal('refused'), code: IdSchema }).strict(),
  z.object({ kind: z.literal('outcomeUnknown'), operationId: IdSchema.optional() }).strict(),
]));
export type OpenProjectResultV1 = z.infer<typeof OpenProjectResultV1Schema>;

/** Private source-host acknowledgement; target Open still validates and accepts its local directory. */
export const ProjectOpenSyncMaterializationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('materialized') }).strict(),
  z.object({ kind: z.literal('refused'), code: IdSchema }).strict(),
  z.object({ kind: z.literal('outcomeUnknown') }).strict(),
]));
export type ProjectOpenSyncMaterializationResultV1 = z.infer<typeof ProjectOpenSyncMaterializationResultV1Schema>;
