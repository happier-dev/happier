import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionExecuteFailureSchema } from '../actions/actionExecutionResult.js';
import { ProjectAccountOrganizationV1Schema } from './projectAccountRowsV1.js';
import { ManagedWorkspaceRefV2WriteSchema, WorkspaceRefV2MachineWriteSchema } from '../workspaces/workspaceRefV1.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.refine(value => value === value.trim())));
const WorkspaceAcknowledgementV1Schema = lazyZodSchema(() => {
  const acknowledgement = {
    label: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    lastOpenedAtMs: z.optional(z.nullable(z.number().check(z.nonnegative()))),
  };
  return z.union([
    z.strictObject({ ...WorkspaceRefV2MachineWriteSchema.shape, ...acknowledgement }),
    z.strictObject({ ...ManagedWorkspaceRefV2WriteSchema.shape, ...acknowledgement }),
  ]);
});

/** Metadata edits only: accepted checkout identity and its root are never Action input. */
export const ProjectWorkspaceUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: IdSchema,
  workspaceId: IdSchema,
  label: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  pinned: z.optional(z.boolean()),
  /** Group the checkout with this Project (its key), or `'self'` to separate it into its own Project. */
  projectKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type ProjectWorkspaceUpdateInputV1 = z.infer<typeof ProjectWorkspaceUpdateInputV1Schema>;
export const ProjectWorkspaceUpdateOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), workspaceRef: WorkspaceAcknowledgementV1Schema,
    organization: z.optional(ProjectAccountOrganizationV1Schema) }),
  ActionExecuteFailureSchema,
]));
export type ProjectWorkspaceUpdateOutputV1 = z.infer<typeof ProjectWorkspaceUpdateOutputV1Schema>;

/** Forget retires an accepted private ref, not its files, Sessions or Source. */
export const ProjectWorkspaceForgetInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: IdSchema,
  workspaceId: IdSchema,
}));
export type ProjectWorkspaceForgetInputV1 = z.infer<typeof ProjectWorkspaceForgetInputV1Schema>;
export const ProjectWorkspaceForgetOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), workspaceId: IdSchema }),
  ActionExecuteFailureSchema,
]));
export type ProjectWorkspaceForgetOutputV1 = z.infer<typeof ProjectWorkspaceForgetOutputV1Schema>;
