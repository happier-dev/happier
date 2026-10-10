import { z } from 'zod';

import { ActionOperationSnapshotV1Schema, ProjectCommandAttachmentV1Schema } from '../actions/operations/v1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachineFinitePolicyV1Schema } from '../machines/machineFinitePolicyV1.js';

export { ProjectWorkerNoAcceptanceReasonV1Schema, type ProjectWorkerNoAcceptanceReasonV1 } from '../actions/projectWorkerRefusal.js';

// These V1 authority/advisory envelopes are closed wire inputs, not stored projections.
export const FiniteAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), operationId: ActionOperationSnapshotV1Schema.shape.operationId,
    machineId: ProjectCommandAttachmentV1Schema.shape.machineId,
    workspaceRefId: ProjectCommandAttachmentV1Schema.shape.workspaceRefId }).strict(),
  z.object({ kind: z.literal('not_accepted'), reason: z.enum([
    'not_accepting', 'draining', 'unsupported', 'forbidden', 'workspace_unavailable',
    'memory_insufficient', 'memory_unavailable',
  ]) }).strict(),
]));
export type FiniteAdmissionV1 = z.infer<typeof FiniteAdmissionV1Schema>;

export const WorkerLoadObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('known'), running: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    queued: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ...MachineFinitePolicyV1Schema.shape }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]));
export type WorkerLoadObservationV1 = z.infer<typeof WorkerLoadObservationV1Schema>;

/** Validated target observation; total, not temporary free memory, determines a too-small refusal. */
export const ProjectWorkerMemoryObservationV1Schema = lazyZodSchema(() => z.object({
  totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine(observation => observation.availableBytes <= observation.totalBytes,
  { message: 'available memory cannot exceed total memory' }));
export type ProjectWorkerMemoryObservationV1 = z.infer<typeof ProjectWorkerMemoryObservationV1Schema>;

export const ProjectWorkerDependencyV1Schema = lazyZodSchema(() => z.object({
  operationId: ActionOperationSnapshotV1Schema.shape.operationId,
  workspaceRefId: ProjectCommandAttachmentV1Schema.shape.workspaceRefId,
  relationshipId: z.string().trim().min(1).optional(),
  state: z.enum(['queued', 'reserved', 'copying', 'setup', 'running']),
}).strict());
export type ProjectWorkerDependencyV1 = z.infer<typeof ProjectWorkerDependencyV1Schema>;

/** Host-private exact-target observation used before reviewed relationship retirement. */
export const ProjectWorkerDependencyQueryV1Schema = lazyZodSchema(() => z.object({
  serverId: z.string().trim().min(1),
  machineId: ProjectCommandAttachmentV1Schema.shape.machineId,
  workspaceRefId: ProjectCommandAttachmentV1Schema.shape.workspaceRefId,
  relationshipId: z.string().trim().min(1),
}).strict());
export type ProjectWorkerDependencyQueryV1 = z.infer<typeof ProjectWorkerDependencyQueryV1Schema>;
