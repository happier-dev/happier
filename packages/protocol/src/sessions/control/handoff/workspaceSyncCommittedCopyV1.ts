import { z } from 'zod';

import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { ProjectWorkerCopyRetireInputV1Schema } from '../../../actions/specs/projectWorkers.js';
import { ProjectWorkerDependencyV1Schema } from '../../../workspaces/projectWorkerExecutionV1.js';
import { WorkspaceExecutionConfigAddressV1Schema } from '../../../workspaces/projectWorkerPreferencesV1.js';
import { WorkspaceSyncRelationshipV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema } from './workspaceSyncSchemas.js';

/** Personal Machine transport carries the exact approved Action, never a caller filesystem path. */
export const WorkspaceSyncCommittedCopyTargetV1Schema = lazyZodSchema(() => z.object({
  actionReceiptId: z.string().trim().min(1),
  actionInput: ProjectWorkerCopyRetireInputV1Schema.refine((input) => input.removeTargetCopy !== undefined,
    'Committed-copy transport requires explicit copy removal'),
}).strict());
export type WorkspaceSyncCommittedCopyTargetV1 = z.infer<typeof WorkspaceSyncCommittedCopyTargetV1Schema>;

export const WorkspaceSyncCommittedCopyTargetResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.literal('workspace_sync_relationship_in_use'),
    dependencies: z.array(ProjectWorkerDependencyV1Schema) }).strict(),
]));
export type WorkspaceSyncCommittedCopyTargetResultV1 = z.infer<typeof WorkspaceSyncCommittedCopyTargetResultV1Schema>;

/** Passive personal review discovery. Current receiving Machine ingress supplies read authority. */
export const WorkspaceSyncCommittedCopyPreviewV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('preview'),
  workspace: WorkspaceExecutionConfigAddressV1Schema,
  machineId: z.string().trim().min(1),
  expectedRelationship: WorkspaceSyncRelationshipV1Schema,
  targetMachineId: z.string().trim().min(1),
  targetWorkspaceRefId: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.targetWorkspaceRefId,
}).strict());
export type WorkspaceSyncCommittedCopyPreviewV1 = z.infer<typeof WorkspaceSyncCommittedCopyPreviewV1Schema>;

export const WorkspaceSyncCommittedCopyPreviewResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), preview: z.object({
    targetMachineId: z.string().trim().min(1),
    workspaceRefId: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.targetWorkspaceRefId,
    rootFingerprint: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.rootFingerprint,
    /** Current logical bytes in regular files, including retained caches; not Sync freshness. */
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict() }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.literal('workspace_copy_not_owned') }).strict(),
]));
export type WorkspaceSyncCommittedCopyPreviewResultV1 = z.infer<typeof WorkspaceSyncCommittedCopyPreviewResultV1Schema>;

/** Only inspect accepts preview. Removal retains the closed approved envelope above. */
export const WorkspaceSyncCommittedCopyInspectV1Schema = lazyZodSchema(() => z.union([
  WorkspaceSyncCommittedCopyTargetV1Schema, WorkspaceSyncCommittedCopyPreviewV1Schema,
]));
export type WorkspaceSyncCommittedCopyInspectV1 = z.infer<typeof WorkspaceSyncCommittedCopyInspectV1Schema>;
export type WorkspaceSyncCommittedCopyInspectResultV1 = WorkspaceSyncCommittedCopyTargetResultV1 | WorkspaceSyncCommittedCopyPreviewResultV1;
