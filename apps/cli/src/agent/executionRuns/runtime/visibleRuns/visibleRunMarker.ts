import { z } from 'zod';

import { AcpConfigOptionOverridesV1Schema, BackendTargetRefSchema, ExecutionRunRoleSchema } from '@happier-dev/protocol';

import type { ExecutionRunSessionController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';

/**
 * The visible-run part of the daemon run marker: what a restarted parent runner needs to rehydrate
 * the run as a `session` controller (plan 2B recovery). Written and read only by the CLI; the
 * marker schema is passthrough, so older daemons keep it untouched. D18: identifiers and controls
 * only, never task instructions or role text; rehydration reads those back from the child Session.
 */
export const VisibleRunMarkerV1Schema = z.object({
  v: z.literal(1),
  linkedSessionId: z.string().min(1),
  binding: z.enum(['created', 'reused']),
  permissionMode: z.string().min(1),
  notifyParentOnCompletion: z.boolean(),
  controls: z.object({
    backendTarget: BackendTargetRefSchema,
    sessionPermissionMode: z.string().min(1),
    modelId: z.string().min(1).nullable(),
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.nullable(),
  }),
  role: z.object({
    id: ExecutionRunRoleSchema,
    assignmentId: z.string().min(1),
    roleSource: z.enum(['explicit', 'settings']),
  }).optional(),
  /** Whether the child confirmed the link; a rehydrated run without it re-arms the handshake. */
  linked: z.boolean(),
  /** Highest accepted child turn epoch, so a rehydrated run keeps rejecting older wake-ups. */
  lastReportedTurnEpoch: z.number().int().min(0),
  /** Absolute task deadline from the start; a restarted runner keeps it, and daemon GC retains the marker past it only for the terminal TTL. */
  deadlineAtMs: z.number().int().nullable(),
}).passthrough();
export type VisibleRunMarkerV1 = z.infer<typeof VisibleRunMarkerV1Schema>;

export function buildVisibleRunMarkerV1(run: ExecutionRunState, ctrl: ExecutionRunSessionController): VisibleRunMarkerV1 {
  return {
    v: 1,
    linkedSessionId: ctrl.linkedSessionId,
    binding: ctrl.binding,
    permissionMode: run.permissionMode,
    notifyParentOnCompletion: run.notifyParentOnCompletion === true,
    controls: {
      backendTarget: ctrl.controls.backendTarget,
      sessionPermissionMode: ctrl.controls.sessionPermissionMode,
      modelId: ctrl.controls.modelId,
      sessionConfigOptionOverrides: ctrl.controls.sessionConfigOptionOverrides,
    },
    ...(run.launch?.role
      ? { role: { id: run.launch.role.id, assignmentId: run.launch.role.assignmentId, roleSource: run.launch.role.roleSource } }
      : {}),
    linked: ctrl.linked,
    lastReportedTurnEpoch: ctrl.lastReportedTurnEpoch,
    deadlineAtMs: ctrl.deadlineAtMs,
  };
}

export function readVisibleRunMarkerV1(marker: unknown): VisibleRunMarkerV1 | null {
  const raw = marker && typeof marker === 'object' ? (marker as { visibleRunV1?: unknown }).visibleRunV1 : undefined;
  const parsed = VisibleRunMarkerV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
