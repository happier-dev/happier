import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import { WorkflowAuthoredProducerRefSchema } from './workflowReferenceV1.js';
import { MachinePoolSelectionOriginV1Schema } from '../machines/pools/v1.js';
import { SessionPlacementSelectionV1Schema, SessionProjectFilesV1Schema } from '../sessions/creation/sessionPlacementSelectionV1.js';

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
  z.strictObject({ kind: z.literal('original') }),
  /** Committed HEAD of the resolved workflow default at this invocation's materialization. */
  z.strictObject({ kind: z.literal('workflow') }),
  /** Committed HEAD of the named producer's workspace at this invocation's materialization. */
  z.strictObject({ kind: z.literal('step'), producer: WorkflowAuthoredProducerRefSchema }),
]));
export type WorkflowWorktreeSource = z.infer<typeof WorkflowWorktreeSourceSchema>;

export const WorkflowWorkspaceSelectionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inherit') }),
  z.strictObject({ kind: z.literal('project_checkout') }),
  z.strictObject({ kind: z.literal('from_step'), producer: WorkflowAuthoredProducerRefSchema }),
  z.strictObject({ kind: z.literal('new_worktree'), source: WorkflowWorktreeSourceSchema,
    displayName: z.optional(z.string().check(z.trim(), z.minLength(1))),
    baseRef: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  }),
]));
export type WorkflowWorkspaceSelection = z.infer<typeof WorkflowWorkspaceSelectionSchema>;

const WorkflowWorkspacePathSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
export const WorkflowCommittedRevisionV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[0-9a-f]{40,64}$/)));

/**
 * Host-selected project facts carried at Workflow admission. Saved and inline
 * definitions never contain this machine-local target, so they remain
 * portable. The target daemon expands it into the accepted descriptor below
 * before any workflow filesystem or agent effect.
 */
export const WorkflowProjectTargetV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: preservedBoundedNfcString(191, 'Workflow Machine ids'),
  directory: WorkflowWorkspacePathSchema,
  workspaceRefId: zMini.optional(preservedBoundedNfcString(191, 'Workspace ids')),
  sessionPlacement: z.optional(SessionPlacementSelectionV1Schema),
}));
export type WorkflowProjectTargetV1 = z.infer<typeof WorkflowProjectTargetV1Schema>;

/** Saved Machine placement chooses the Run host before its workspace is admitted. */
export function resolveWorkflowProjectTargetMachineV1(project: WorkflowProjectTargetV1): WorkflowProjectTargetV1 {
  const selected = project.sessionPlacement;
  if (selected?.kind !== 'machine' || selected.target.machineId === project.machineId) return project;
  const { workspaceRefId: _previousMachineWorkspace, ...intent } = project;
  return { ...intent, machineId: selected.target.machineId };
}

/**
 * What a person picks for "Runs on": a Machine, or a Machine pool that the existing pool
 * placement owner (`machines.pools.resolve`) resolves to one Machine once, when the Run starts.
 * Every step then runs on that Run's Machine.
 */
export const WorkflowRunsOnTargetV1Schema = lazyZodSchema(() => z.union([
  WorkflowProjectTargetV1Schema,
  z.strictObject({ pool: MachinePoolSelectionOriginV1Schema, directory: WorkflowWorkspacePathSchema }),
]));
export type WorkflowRunsOnTargetV1 = z.infer<typeof WorkflowRunsOnTargetV1Schema>;

export const WorkflowResolvedInvocationRefV1Schema = lazyZodSchema(() => z.strictObject({
  producer: WorkflowAuthoredProducerRefSchema,
  invocationRecordId: preservedBoundedNfcString(191, 'Workflow invocation record ids'),
}));

export const WorkflowWorkspaceDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: preservedBoundedNfcString(191, 'Workflow Machine ids'),
  directory: WorkflowWorkspacePathSchema,
  checkoutRootPath: WorkflowWorkspacePathSchema,
  workspaceRefId: zMini.optional(preservedBoundedNfcString(191, 'Workspace ids')),
  sourceInvocation: z.optional(WorkflowResolvedInvocationRefV1Schema),
  checkout: z.optional(z.strictObject({
    kind: z.literal('git_worktree'),
    branchName: z.string().check(z.minLength(1)),
  })),
}));
export type WorkflowWorkspaceDescriptorV1 = z.infer<typeof WorkflowWorkspaceDescriptorV1Schema>;

/** Immutable machine-local workspace facts sealed into the accepted Run. */
export const WorkflowAcceptedWorkspaceTargetV1Schema = lazyZodSchema(() => z.strictObject({
  project: WorkflowWorkspaceDescriptorV1Schema,
  sessionPlacement: z.optional(SessionPlacementSelectionV1Schema),
  /** Effective authored override or trusted private preset default, frozen at admission. */
  projectFiles: z.optional(SessionProjectFilesV1Schema),
  originalCommittedRevision: z.optional(WorkflowCommittedRevisionV1Schema),
}));
export type WorkflowAcceptedWorkspaceTargetV1 = z.infer<typeof WorkflowAcceptedWorkspaceTargetV1Schema>;
export type WorkflowAcceptedWorkspaceTargetPreparation =
  | Readonly<{ ok: true; workspaceTarget: WorkflowAcceptedWorkspaceTargetV1 }>
  | Readonly<{ ok: false; code: 'workspace_unavailable' | 'workspace_conflict' | 'committed_revision_unavailable' | 'workflow_in_place_not_available' }>;

export const WorkflowWorkspaceCreationIntentV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('git_worktree'),
  sourceDirectory: WorkflowWorkspacePathSchema,
  baseRef: z.string().check(z.trim(), z.minLength(1)),
  displayName: z.string().check(z.minLength(1)),
  branchMode: z.literal('new'),
}));
export type WorkflowWorkspaceCreationIntentV1 = z.infer<typeof WorkflowWorkspaceCreationIntentV1Schema>;

/** Private row-local correspondence persisted before and after the SCM effect. */
export const WorkflowWorkspaceProgressV1Schema = lazyZodSchema(() => z.strictObject({
  creationIntent: z.optional(WorkflowWorkspaceCreationIntentV1Schema),
  descriptor: z.optional(WorkflowWorkspaceDescriptorV1Schema),
}).check(z.refine((value) => value.creationIntent !== undefined || value.descriptor !== undefined, {
  message: 'Workspace progress requires creation intent or a resolved descriptor',
})));
export type WorkflowWorkspaceProgressV1 = z.infer<typeof WorkflowWorkspaceProgressV1Schema>;

export const WorkflowWorkspaceResolutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), workspace: WorkflowWorkspaceDescriptorV1Schema }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'conversation_workspace_mismatch', 'source_workspace_unavailable',
      'committed_revision_unavailable', 'workspace_unavailable',
      'workspace_conflict', 'scm_unavailable',
    ]),
  }),
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
