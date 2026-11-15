import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { computeSha256HexDigest } from '../crypto/canonicalDigest.js';
import { SocketRpcMachineAdmissionContextV1Schema } from '../machines/machineAccessV1.js';
import { DevcontainerChildProjectionV1Schema } from '../machines/managed/devcontainerV1.js';
import { ManagedControllerV1Schema } from '../machines/managed/managedMachineV1.js';
import { OpenProjectInputV1Schema } from '../projects/openProjectV1.js';
import { isProjectWorkspaceSyncOpenActionV1, isProjectWorkspaceSyncPreparationActionV1 } from '../actions/projectActionIdsV1.js';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '../actions/projectActionFamily.js';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '../local/services/launcher/v1.js';
import { ProjectServiceRelocateInputV1Schema } from './projectServiceRelocationV1.js';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '../actions/externalActionApi.js';
import type { OpenProjectInputV1 } from '../projects/openProjectV1.js';
import type { WorkspaceSyncRelationshipCreateActionInputV1 } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import type { WorkspaceAddressV1 } from './workspaceRefV1.js';

/** The incumbent relationship identity, shared by its issuer and both endpoints. */
export function deriveWorkspaceSyncRelationshipId(operationId: string): string {
  return `relationship_${computeSha256HexDigest(operationId)}`;
}

const id = () => z.string().check(z.minLength(1));
/** Home-readable identifiers only; checkout paths and Action content remain sealed. */
export const WorkspaceSyncAdmissionInputV1Schema = lazyZodSchema(() => z.strictObject({
  sourceMachineId: id(), sourceWorkspaceRefId: id(),
  relationshipId: z.optional(id()),
}));
export type WorkspaceSyncAdmissionInputV1 = z.infer<typeof WorkspaceSyncAdmissionInputV1Schema>;

/** Home-produced source custody and native mapping, never a Machine row or credential. */
export const WorkspaceSyncAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: id(), sourceWorkspaceRefId: id(),
  source: SocketRpcMachineAdmissionContextV1Schema,
  child: z.optional(z.strictObject({ projection: DevcontainerChildProjectionV1Schema,
    controller: ManagedControllerV1Schema })),
}));
export type WorkspaceSyncAdmissionV1 = z.infer<typeof WorkspaceSyncAdmissionV1Schema>;

/** Correspondence only: the RPC ingress already authenticated the signed binding. */
export function readWorkspaceSyncSourceAdmissionV1(binding: ExternalActionExecutionAuthorizationBindingV1,
  expected: Readonly<{ serverId: string; relationshipId: string; machineId: string; workspaceRefId?: string }>): WorkspaceSyncAdmissionV1 | null {
  const admitted = binding.workspaceSyncAdmission;
  return admitted && (isProjectWorkspaceSyncOpenActionV1(binding.actionId) || isProjectWorkspaceSyncPreparationActionV1(binding.actionId))
    && binding.serverIdentityId === expected.serverId && admitted.source.machineId === expected.machineId
    && admitted.relationshipId === expected.relationshipId
    && (expected.workspaceRefId === undefined || admitted.sourceWorkspaceRefId === expected.workspaceRefId) ? admitted : null;
}

/**
 * Add Machine into a Can use destination: Project Open Sync of the source Workspace on the destination.
 * The source checkout names the source Machine Home admits as SOURCE; a workspace-only Open would
 * name the destination instead (R126S3).
 */
export function buildWorkspaceSyncDestinationOpenInputV1(input: Readonly<{
  serverId: string;
  source: WorkspaceAddressV1;
  link: Pick<WorkspaceSyncRelationshipCreateActionInputV1, 'targetMachineId' | 'targetPath' | 'mode' | 'contentPolicy'>;
}>): OpenProjectInputV1 {
  return OpenProjectInputV1Schema.parse({
    serverId: input.serverId, machineId: input.link.targetMachineId,
    source: { kind: 'workspace', workspaceId: input.source.workspaceId, checkout: input.source },
    materialization: { kind: 'sync', targetPath: input.link.targetPath, workspaceAction: { kind: 'create_relationship',
      mode: input.link.mode, contentPolicy: input.link.contentPolicy, flushBeforeCommit: true } },
  });
}

export function projectWorkspaceSyncAdmissionInputV1(actionId: string, input: unknown): WorkspaceSyncAdmissionInputV1 | undefined {
  if (isProjectWorkspaceSyncPreparationActionV1(actionId)) {
    if (actionId === 'projects.service.relocate') {
      const parsed = ProjectServiceRelocateInputV1Schema.safeParse(input);
      return parsed.success
        ? { sourceMachineId: parsed.data.sourceMachineId, sourceWorkspaceRefId: parsed.data.workspace.refId } : undefined;
    }
    const parsed = actionId === 'localServices.launcher.start'
      ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(input)
      : PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
    if (!parsed.success || !parsed.data.workspace) return undefined;
    return { sourceMachineId: parsed.data.workspace.machineId, sourceWorkspaceRefId: parsed.data.workspace.workspaceId };
  }
  if (!isProjectWorkspaceSyncOpenActionV1(actionId)) return undefined;
  const parsed = OpenProjectInputV1Schema.safeParse(input);
  if (!parsed.success || parsed.data.materialization.kind !== 'sync') return undefined;
  const source = parsed.data.source;
  const action = parsed.data.materialization.workspaceAction;
  if (source.kind === 'workspace') {
    // Workspace-only names a source on the opening Machine (released same-Machine worker copy,
    // a0ef8b30543); a source on another Machine carries its checkout.
    return { sourceMachineId: source.checkout?.machineId ?? parsed.data.machineId,
      sourceWorkspaceRefId: source.checkout?.workspaceId ?? source.workspaceId,
      ...(action.kind === 'relationship' ? { relationshipId: action.relationshipId } : {}) };
  }
  if (source.kind !== 'source' || !source.checkout) return undefined;
  return { sourceMachineId: source.checkout.machineId, sourceWorkspaceRefId: source.checkout.workspaceId,
    ...(action.kind === 'relationship' ? { relationshipId: action.relationshipId } : {}) };
}
