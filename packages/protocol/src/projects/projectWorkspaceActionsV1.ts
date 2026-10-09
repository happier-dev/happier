import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionExecuteFailureSchema } from '../actions/actionExecutionResult.js';
import { ProjectAccountOrganizationV1Schema } from './projectAccountRowsV1.js';
import { WorkspaceRefV1WriteSchema } from '../workspaces/workspaceRefV1.js';

const IdSchema = lazyZodSchema(() => z.string().min(1).refine(value => value === value.trim()));
const WorkspaceAcknowledgementV1Schema = lazyZodSchema(() => z.object({
  ...WorkspaceRefV1WriteSchema.shape,
  label: z.string().min(1).nullable().optional(),
  lastOpenedAtMs: z.number().finite().nonnegative().nullable().optional(),
}).strict());

/** Metadata edits only: accepted checkout identity and its root are never Action input. */
export const ProjectWorkspaceUpdateInputV1Schema = lazyZodSchema(() => z.object({
  serverId: IdSchema,
  workspaceId: IdSchema,
  label: z.string().trim().min(1).nullable().optional(),
  pinned: z.boolean().optional(),
}).strict());
export type ProjectWorkspaceUpdateInputV1 = z.infer<typeof ProjectWorkspaceUpdateInputV1Schema>;
export const ProjectWorkspaceUpdateOutputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), workspaceRef: WorkspaceAcknowledgementV1Schema,
    organization: z.optional(ProjectAccountOrganizationV1Schema) }).strict(),
  ActionExecuteFailureSchema,
]));
export type ProjectWorkspaceUpdateOutputV1 = z.infer<typeof ProjectWorkspaceUpdateOutputV1Schema>;

/** Forget retires an accepted private ref, not its files, Sessions or Source. */
export const ProjectWorkspaceForgetInputV1Schema = lazyZodSchema(() => z.object({
  serverId: IdSchema,
  workspaceId: IdSchema,
}).strict());
export type ProjectWorkspaceForgetInputV1 = z.infer<typeof ProjectWorkspaceForgetInputV1Schema>;
export const ProjectWorkspaceForgetOutputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), workspaceId: IdSchema }).strict(),
  ActionExecuteFailureSchema,
]));
export type ProjectWorkspaceForgetOutputV1 = z.infer<typeof ProjectWorkspaceForgetOutputV1Schema>;
