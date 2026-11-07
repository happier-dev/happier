import { z } from 'zod/mini';

import { ActionOperationSnapshotV1Schema } from '../actions/operations/v1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { LocalServiceActionTargetV1Schema } from '../local/services/actions/v1.js';
import { LocalServiceActionRequestV1Schema, createProjectServiceDeclarationTargetIdV1 } from '../local/services/actions/v1.js';
import { DaemonLocalServiceLauncherSnapshotRequestV1Schema, DaemonLocalServiceLauncherStartRequestV1Schema } from '../local/services/launcher/v1.js';
import { TargetedActionRpcRequestV1Schema } from '../actions/actionRpcTransport.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { ProjectWorkerStatusInputV1Schema } from '../actions/specs/projectWorkers.js';
import { ProjectServicePlacementGetV1Schema, ProjectServicePlacementSetV1Schema } from './projectServicePlacementV1.js';
import { ProjectExecutionChoiceV1Schema } from './projectWorkerPreferencesV1.js';
import { ProjectDefinitionInspectInputSchema } from '../actions/projectDefinitionActionFamily.js';

/** Reuses Local Services' exact managed identity; input never establishes control authority. */
export const ProjectServiceRelocateInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProjectServicePlacementGetV1Schema, {
  requestId: ActionOperationSnapshotV1Schema.shape.requestId._zod.def.innerType,
  /** The reviewed source checkout Machine; the running service may be on another Machine. */
  sourceMachineId: z.string().check(z.minLength(1)),
  currentTarget: LocalServiceActionTargetV1Schema._zod.def.options[1],
  /** The sibling-preserving placement CAS that must settle before native Stop. */
  desiredPlacement: ProjectServicePlacementSetV1Schema,
  destination: ProjectExecutionChoiceV1Schema,
  /** Exact target and native effect basis reviewed before approval; Auto is never re-ranked later. */
  selectedTarget: z.strictObject({ machineId: z.string().check(z.minLength(1)) }),
})));
export type ProjectServiceRelocateInputV1 = z.infer<typeof ProjectServiceRelocateInputV1Schema>;

/** The SOURCE runner consumes its active Move's Start admission; no durable replay ledger. */
export const ProjectServiceMoveStartClaimV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: ActionOperationSnapshotV1Schema.shape.requestId._zod.def.innerType,
  installationId: z.string().check(z.minLength(1)),
  input: ProjectServiceRelocateInputV1Schema,
}));
export const ProjectServiceMoveStartClaimResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('claimed') }),
  z.strictObject({ kind: z.literal('refused'), reasonCode: z.enum([
    'service_move_not_starting', 'service_move_start_already_claimed', 'service_move_start_authority_unavailable',
  ]) }),
]));
export type ProjectServiceMoveStartClaimResultV1 = z.infer<typeof ProjectServiceMoveStartClaimResultV1Schema>;

/** Closed child effects of a reviewed Move; this projection grants no Machine access. */
export function readProjectServiceMoveChildEffectV1(method: string): string | null {
  if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) return 'localServices.launcher.snapshot';
  if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_STOP_MANAGED) return 'localServices.actions.stopManaged';
  if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) return 'localServices.launcher.start';
  if (method === 'daemon.projects.inspect.v1') return 'projects.inspect';
  // Status's canonical Action binding uses this exact method identity.
  if (method === 'projects.worker.status') return 'projects.worker.status';
  return null;
}

export function readProjectServiceMoveChildMachineV1(rootInput: unknown, actionId: string): string | null {
  const root = ProjectServiceRelocateInputV1Schema.safeParse(rootInput);
  if (!root.success) return null;
  if (actionId === 'localServices.launcher.snapshot' || actionId === 'localServices.actions.stopManaged') return root.data.currentTarget.machineId;
  if (actionId === 'projects.worker.status' || actionId === 'localServices.launcher.start') return root.data.selectedTarget.machineId;
  return null;
}

/** Sender and decrypted receiver share the exact reviewed service/destination decision. */
export function isProjectServiceMoveChildInputV1(rootInput: unknown, actionId: string, machineId: string, value: unknown): boolean {
  const root = ProjectServiceRelocateInputV1Schema.safeParse(rootInput);
  if (!root.success) return false;
  const move = root.data;
  if (actionId !== 'projects.inspect' && readProjectServiceMoveChildMachineV1(move, actionId) !== machineId) return false;
  const wrapper = TargetedActionRpcRequestV1Schema.safeParse(value);
  if (wrapper.success && (wrapper.data.target.kind !== 'machine' || wrapper.data.target.machineId !== machineId)) return false;
  const input = wrapper.success ? wrapper.data.input : value;
  if (actionId === 'projects.inspect') {
    const inspection = ProjectDefinitionInspectInputSchema.safeParse(input);
    // Current Account refs/root authority are checked at both transport ends by isReviewedServiceMoveChild.
    return inspection.success && inspection.data.workspace.serverId === move.workspace.serverId
      && inspection.data.workspace.machineId === machineId;
  }
  if (actionId === 'projects.worker.status') {
    const status = ProjectWorkerStatusInputV1Schema.safeParse(input);
    return status.success && machineId === move.selectedTarget.machineId
      && status.data.destination.machineId === machineId && status.data.purpose === 'service-start'
      && sameStrictJsonValue(status.data.workspace, move.workspace);
  }
  if (actionId === 'localServices.launcher.snapshot') {
    const snapshot = DaemonLocalServiceLauncherSnapshotRequestV1Schema.safeParse(input);
    return snapshot.success && machineId === move.currentTarget.machineId && snapshot.data.machineId === machineId
      && snapshot.data.projection === 'managed_bindings' && snapshot.data.scope === 'workspace';
  }
  if (actionId === 'localServices.actions.stopManaged') {
    const stop = LocalServiceActionRequestV1Schema.safeParse(input);
    return stop.success && machineId === move.currentTarget.machineId && stop.data.action === 'stop_managed'
      && !stop.data.force && sameStrictJsonValue(stop.data.target, move.currentTarget);
  }
  if (actionId === 'localServices.launcher.start') {
    const start = DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(input);
    const choice = move.destination.kind === 'primary' ? { kind: 'primary' }
      : { kind: 'workers', destination: { kind: 'machine', machineId } };
    return start.success && machineId === move.selectedTarget.machineId && start.data.machineId === machineId
      && start.data.sessionId === undefined && start.data.workspaceId === start.data.workspace?.workspaceId
      && sameStrictJsonValue(start.data.choice, choice)
      && start.data.workspace?.serverId === move.workspace.serverId && start.data.workspace.machineId === machineId
      && start.data.declaration !== undefined && start.data.declaration.workspaceRefId === start.data.workspace.workspaceId
      && sameStrictJsonValue(start.data.declaration.selection, move.currentTarget.declaration?.selection)
      && start.data.targetId === createProjectServiceDeclarationTargetIdV1({ id: start.data.workspace.workspaceId,
        serverId: move.workspace.serverId, machineId }, start.data.declaration.selection);
  }
  return false;
}

export const ProjectServiceRelocateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), operation: ActionOperationSnapshotV1Schema }),
  z.strictObject({ status: z.enum(['moved', 'unchanged']), currentTarget: LocalServiceActionTargetV1Schema._zod.def.options[1] }),
  z.strictObject({ status: z.enum(['refused', 'unsupported']), reasonCode: z.string().check(z.minLength(1)) }),
]));
export type ProjectServiceRelocateResultV1 = z.infer<typeof ProjectServiceRelocateResultV1Schema>;
