import { z } from '../zodRuntimePolicy.js';

import { ActionOperationSnapshotV1Schema, ProjectCommandAttachmentV1Schema } from '../actions/operations/v1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachineFinitePolicyV1Schema } from '../machines/machineFinitePolicyV1.js';

export { ProjectWorkerNoAcceptanceReasonV1Schema, type ProjectWorkerNoAcceptanceReasonV1 } from '../actions/projectWorkerRefusal.js';

// These V1 authority/advisory envelopes are closed wire inputs, not stored projections.
export const FiniteAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), operationId: ActionOperationSnapshotV1Schema.shape.operationId,
    machineId: ProjectCommandAttachmentV1Schema.shape.machineId,
    workspaceRefId: ProjectCommandAttachmentV1Schema.shape.workspaceRefId }),
  z.strictObject({ kind: z.literal('not_accepted'), reason: z.enum([
    'not_accepting', 'draining', 'unsupported', 'forbidden', 'workspace_unavailable',
    'memory_insufficient', 'memory_unavailable',
  ]) }),
]));
export type FiniteAdmissionV1 = z.infer<typeof FiniteAdmissionV1Schema>;

export const WorkerLoadObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('known'), running: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
    queued: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
    ...MachineFinitePolicyV1Schema.shape }),
  z.strictObject({ kind: z.literal('unknown') }),
]));
export type WorkerLoadObservationV1 = z.infer<typeof WorkerLoadObservationV1Schema>;

/** Validated target observation; total, not temporary free memory, determines a too-small refusal. */
export const ProjectWorkerMemoryObservationV1Schema = lazyZodSchema(() => z.strictObject({
  totalBytes: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
  availableBytes: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
}).check(z.refine(observation => observation.availableBytes <= observation.totalBytes, { message: 'available memory cannot exceed total memory' })));
export type ProjectWorkerMemoryObservationV1 = z.infer<typeof ProjectWorkerMemoryObservationV1Schema>;

export const ProjectWorkerDependencyV1Schema = lazyZodSchema(() => z.strictObject({
  operationId: ActionOperationSnapshotV1Schema.shape.operationId,
  workspaceRefId: ProjectCommandAttachmentV1Schema.shape.workspaceRefId,
  relationshipId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  state: z.enum(['queued', 'reserved', 'copying', 'setup', 'running']),
}));
export type ProjectWorkerDependencyV1 = z.infer<typeof ProjectWorkerDependencyV1Schema>;

/** Host-private exact-target observation used before reviewed relationship retirement. */
export const ProjectWorkerDependencyQueryV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)),
  machineId: ProjectCommandAttachmentV1Schema.shape.machineId,
  workspaceRefId: ProjectCommandAttachmentV1Schema.shape.workspaceRefId,
  relationshipId: z.string().check(z.trim(), z.minLength(1)),
}));
export type ProjectWorkerDependencyQueryV1 = z.infer<typeof ProjectWorkerDependencyQueryV1Schema>;
