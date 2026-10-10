import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import { WorkflowAuthoredProducerRefSchema } from './workflowReferenceV1.js';

/**
 * Authored workspace **selection** for a workflow definition (SPACE §3.2).
 *
 * This module owns only the authored half of the workspace contract — what the
 * user chose in the editor and what round-trips through a saved definition. The
 * resolved descriptor (machine, exact directory, checkout root, materialization
 * correspondence) and its unavailable/conflict outcomes are runtime
 * materialization facts owned by the workspace resolution adapter, and are
 * deliberately not declared here: a definition must never carry a resolved
 * absolute path as if it were authored content.
 *
 * Selection meanings, all resolved at materialization time:
 *
 * - `inherit` resolves the stable workflow default, never the last-finishing
 *   sibling or a previous iteration.
 * - `project_checkout` resolves the originally selected project directory. That
 *   directory may itself already be a linked worktree; "project folder" does
 *   not mean branch `main`.
 * - `from_step` resolves the named producer invocation's recorded exact
 *   directory, including its dirty, staged and untracked state. No Git
 *   operation is implied.
 * - `new_worktree` creates a checkout from the source's **committed** state at
 *   materialization. Staged, uncommitted and untracked changes stay at the
 *   source.
 */

export const WorkflowWorktreeSourceSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  /** Committed HEAD captured during workflow initialization, before the first agent can mutate the project. */
  z.object({ kind: z.literal('original') }).strict(),
  /** Committed HEAD of the resolved workflow default at this invocation's materialization. */
  z.object({ kind: z.literal('workflow') }).strict(),
  /** Committed HEAD of the named producer's workspace at this invocation's materialization. */
  z.object({ kind: z.literal('step'), producer: WorkflowAuthoredProducerRefSchema }).strict(),
]));
export type WorkflowWorktreeSource = z.infer<typeof WorkflowWorktreeSourceSchema>;

export const WorkflowWorkspaceSelectionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit') }).strict(),
  z.object({ kind: z.literal('project_checkout') }).strict(),
  z.object({ kind: z.literal('from_step'), producer: WorkflowAuthoredProducerRefSchema }).strict(),
  z.object({ kind: z.literal('new_worktree'), source: WorkflowWorktreeSourceSchema,
    displayName: z.string().trim().min(1).optional(),
    baseRef: z.string().trim().min(1).nullable().optional(),
  }).strict(),
]));
export type WorkflowWorkspaceSelection = z.infer<typeof WorkflowWorkspaceSelectionSchema>;

const WorkflowWorkspacePathSchema = lazyZodSchema(() => z.string().min(1));
export const WorkflowCommittedRevisionV1Schema = lazyZodSchema(() => z.string().regex(/^[0-9a-f]{40,64}$/));

/**
 * Host-selected project facts carried at Workflow admission. Saved and inline
 * definitions never contain this machine-local target, so they remain
 * portable. The target daemon expands it into the accepted descriptor below
 * before any workflow filesystem or agent effect.
 */
export const WorkflowProjectTargetV1Schema = lazyZodSchema(() => z.object({
  machineId: preservedBoundedNfcString(191, 'Workflow Machine ids'),
  directory: WorkflowWorkspacePathSchema,
  workspaceRefId: preservedBoundedNfcString(191, 'Workspace ids').optional(),
}).strict());
export type WorkflowProjectTargetV1 = z.infer<typeof WorkflowProjectTargetV1Schema>;

export const WorkflowResolvedInvocationRefV1Schema = lazyZodSchema(() => z.object({
  producer: WorkflowAuthoredProducerRefSchema,
  invocationRecordId: preservedBoundedNfcString(191, 'Workflow invocation record ids'),
}).strict());

export const WorkflowWorkspaceDescriptorV1Schema = lazyZodSchema(() => z.object({
  machineId: preservedBoundedNfcString(191, 'Workflow Machine ids'),
  directory: WorkflowWorkspacePathSchema,
  checkoutRootPath: WorkflowWorkspacePathSchema,
  workspaceRefId: preservedBoundedNfcString(191, 'Workspace ids').optional(),
  sourceInvocation: WorkflowResolvedInvocationRefV1Schema.optional(),
  checkout: z.object({
    kind: z.literal('git_worktree'),
    branchName: z.string().min(1),
  }).strict().optional(),
}).strict());
export type WorkflowWorkspaceDescriptorV1 = z.infer<typeof WorkflowWorkspaceDescriptorV1Schema>;

/** Immutable machine-local workspace facts sealed into the accepted Run. */
export const WorkflowAcceptedWorkspaceTargetV1Schema = lazyZodSchema(() => z.object({
  project: WorkflowWorkspaceDescriptorV1Schema,
  originalCommittedRevision: WorkflowCommittedRevisionV1Schema.optional(),
}).strict());
export type WorkflowAcceptedWorkspaceTargetV1 = z.infer<typeof WorkflowAcceptedWorkspaceTargetV1Schema>;

export const WorkflowWorkspaceCreationIntentV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('git_worktree'),
  sourceDirectory: WorkflowWorkspacePathSchema,
  baseRef: z.string().trim().min(1),
  displayName: z.string().min(1),
  branchMode: z.literal('new'),
}).strict());
export type WorkflowWorkspaceCreationIntentV1 = z.infer<typeof WorkflowWorkspaceCreationIntentV1Schema>;

/** Private row-local correspondence persisted before and after the SCM effect. */
export const WorkflowWorkspaceProgressV1Schema = lazyZodSchema(() => z.object({
  creationIntent: WorkflowWorkspaceCreationIntentV1Schema.optional(),
  descriptor: WorkflowWorkspaceDescriptorV1Schema.optional(),
}).strict().refine((value) => value.creationIntent !== undefined || value.descriptor !== undefined, {
  message: 'Workspace progress requires creation intent or a resolved descriptor',
}));
export type WorkflowWorkspaceProgressV1 = z.infer<typeof WorkflowWorkspaceProgressV1Schema>;

export const WorkflowWorkspaceResolutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), workspace: WorkflowWorkspaceDescriptorV1Schema }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'conversation_workspace_mismatch', 'source_workspace_unavailable',
      'committed_revision_unavailable', 'workspace_unavailable',
      'workspace_conflict', 'scm_unavailable',
    ]),
  }).strict(),
]));
export type WorkflowWorkspaceResolutionV1 = z.infer<typeof WorkflowWorkspaceResolutionV1Schema>;

/** The producer reference a workspace selection resolves, when it names one. */
export function readWorkflowWorkspaceProducerRef(
  selection: WorkflowWorkspaceSelection,
): z.infer<typeof WorkflowAuthoredProducerRefSchema> | null {
  if (selection.kind === 'from_step') return selection.producer;
  if (selection.kind === 'new_worktree' && selection.source.kind === 'step') return selection.source.producer;
  return null;
}
