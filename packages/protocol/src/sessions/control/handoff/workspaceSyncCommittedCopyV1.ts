import { z } from '../../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { ProjectWorkerCopyRetireInputV1Schema } from '../../../actions/specs/projectWorkers.js';
import { readWorkspaceSyncCopyRetirementReceiptV1 } from '../../../actions/specs/projectWorkersActionIdsV1.js';
export { readWorkspaceSyncCopyRetirementReceiptV1 } from '../../../actions/specs/projectWorkersActionIdsV1.js';
import type { ExternalActionExecutionAuthorizationV1 } from '../../../actions/externalActionApi.js';
import type { WorkspaceSyncSourceWriterTargetRoutingV1 } from '../../../rpc/socket.js';
import { ProjectWorkerDependencyV1Schema } from '../../../workspaces/projectWorkerExecutionV1.js';
import { WorkspaceExecutionConfigAddressV1Schema } from '../../../workspaces/projectWorkerPreferencesV1.js';
import { WorkspaceSyncRelationshipV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema } from './workspaceSyncSchemas.js';

/** Personal Machine transport carries the exact approved Action, never a caller filesystem path. */
export const WorkspaceSyncCommittedCopyTargetV1Schema = lazyZodSchema(() => z.strictObject({
  actionReceiptId: z.string().check(z.trim(), z.minLength(1)),
  actionInput: ProjectWorkerCopyRetireInputV1Schema.check(z.refine((input) => input.removeTargetCopy !== undefined, 'Committed-copy transport requires explicit copy removal')),
}));
export type WorkspaceSyncCommittedCopyTargetV1 = z.infer<typeof WorkspaceSyncCommittedCopyTargetV1Schema>;

/** A current SOURCE root authorizes the effect; the retained TARGET loan owns physical scope. */
export function doesWorkspaceSyncCopyRetirementRootMatchV1(authorization: ExternalActionExecutionAuthorizationV1,
  routing: WorkspaceSyncSourceWriterTargetRoutingV1): boolean {
  const binding = authorization.binding;
  const source = routing.source.sourceContext.machineAdmission;
  return readWorkspaceSyncCopyRetirementReceiptV1(binding) !== null
    && binding.serverIdentityId === routing.source.accountServerId && binding.serverIdentityId === routing.target.accountServerId
    && binding.accountId === source.actorAccountId && binding.machineId === routing.source.sourceMachineId
    && binding.installationId === source.installationId && binding.custodianAccountId === source.custodianAccountId;
}

export function doesWorkspaceSyncCopyRetirementRequestMatchV1(authorization: ExternalActionExecutionAuthorizationV1,
  routing: WorkspaceSyncSourceWriterTargetRoutingV1, request: unknown): boolean {
  const parsed = WorkspaceSyncCommittedCopyTargetV1Schema.safeParse(request);
  return parsed.success && doesWorkspaceSyncCopyRetirementRootMatchV1(authorization, routing)
    && parsed.data.actionReceiptId === readWorkspaceSyncCopyRetirementReceiptV1(authorization.binding)
    && parsed.data.actionInput.machineId === routing.source.sourceMachineId
    && parsed.data.actionInput.workspace.serverId === authorization.binding.serverIdentityId;
}

/** Inspect has a passive preview alternative; all removal-shaped requests spend the current root. */
export function isWorkspaceSyncApprovedCopyPhaseV1(phase: string, request: unknown): boolean {
  return phase === 'remove' || phase === 'inspect' && !WorkspaceSyncCommittedCopyPreviewV1Schema.safeParse(request).success;
}

export const WorkspaceSyncCommittedCopyTargetResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), errorCode: z.literal('workspace_sync_relationship_in_use'),
    dependencies: z.array(ProjectWorkerDependencyV1Schema) }),
]));
export type WorkspaceSyncCommittedCopyTargetResultV1 = z.infer<typeof WorkspaceSyncCommittedCopyTargetResultV1Schema>;

/** Passive personal review discovery. Current receiving Machine ingress supplies read authority. */
export const WorkspaceSyncCommittedCopyPreviewV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('preview'),
  workspace: WorkspaceExecutionConfigAddressV1Schema,
  machineId: z.string().check(z.trim(), z.minLength(1)),
  expectedRelationship: WorkspaceSyncRelationshipV1Schema,
  targetMachineId: z.string().check(z.trim(), z.minLength(1)),
  targetWorkspaceRefId: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.targetWorkspaceRefId,
}));
export type WorkspaceSyncCommittedCopyPreviewV1 = z.infer<typeof WorkspaceSyncCommittedCopyPreviewV1Schema>;

export const WorkspaceSyncCommittedCopyPreviewResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), preview: z.strictObject({
    targetMachineId: z.string().check(z.trim(), z.minLength(1)),
    workspaceRefId: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.targetWorkspaceRefId,
    rootFingerprint: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.shape.rootFingerprint,
    /** Current logical bytes in regular files, including retained caches; not Sync freshness. */
    sizeBytes: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
  }) }),
  z.strictObject({ ok: z.literal(false), errorCode: z.literal('workspace_copy_not_owned') }),
]));
export type WorkspaceSyncCommittedCopyPreviewResultV1 = z.infer<typeof WorkspaceSyncCommittedCopyPreviewResultV1Schema>;

/** Only inspect accepts preview. Removal retains the closed approved envelope above. */
export const WorkspaceSyncCommittedCopyInspectV1Schema = lazyZodSchema(() => z.union([
  WorkspaceSyncCommittedCopyTargetV1Schema, WorkspaceSyncCommittedCopyPreviewV1Schema,
]));
export type WorkspaceSyncCommittedCopyInspectV1 = z.infer<typeof WorkspaceSyncCommittedCopyInspectV1Schema>;
export type WorkspaceSyncCommittedCopyInspectResultV1 = WorkspaceSyncCommittedCopyTargetResultV1 | WorkspaceSyncCommittedCopyPreviewResultV1;
