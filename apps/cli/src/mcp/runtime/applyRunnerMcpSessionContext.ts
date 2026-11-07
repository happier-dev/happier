import type { Metadata, PermissionMode } from '@/api/types';
import type { AgentCompositionToolSelection } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import type {
  PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';
import type { RuntimeActiveTurnPermissionWitness } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { ResolvedRolesSnapshotV1 } from '@happier-dev/protocol';
import type { RoleSourceReader } from '@/session/roles/roleSources';
import type { SessionSkillReadItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
type WorkspaceWritesPolicyPreparation = (workspaceWrites: 'allow' | 'deny', context: import('@happier-dev/protocol').ActionExecutorContext) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string }>>;

export type RunnerMcpSessionContextAccessors = Readonly<{
  getSessionRoleContext?: () => import('@/session/roles/sessionRoleContext').SessionRoleContext;
  getPluginMcpRuntimeRegistry?: () => import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry').ResolvedExecutablePluginRuntimeRegistry | null;
  getPluginMcpPort?: () => import('./pluginMcpPort').PluginMcpPort | null;
  getCurrentSessionSkillItems?: () => readonly SessionSkillReadItemV1[] | null;
  getCurrentResolvedRoles?: () => ResolvedRolesSnapshotV1;
  readRoleSources?: RoleSourceReader;
  getCurrentWorkspaceWrites?: () => 'allow' | 'deny' | undefined;
  prepareWorkspaceWritesPolicy?: WorkspaceWritesPolicyPreparation;
  getPermissionMode?: (() => PermissionMode | null | undefined) | null;
  getActiveTurnPermissionWitness?: (() => RuntimeActiveTurnPermissionWitness | null | undefined) | null;
  getActiveTurnAdmissionWitness?: (() => import('@/plugins/runtime/invocation/services/types').AgentInvocationTurnAdmissionWitness | null) | null;
  getRuntimeLifetimeSignal?: (() => AbortSignal | null | undefined) | null;
  getHostTurnAbortSignal?: (() => AbortSignal | null | undefined) | null;
  getBackendTarget?: (() => PersistedBackendTargetRefV2 | null | undefined) | null;
  getCurrentSessionLocation?: (() => Readonly<{
    path?: string | null;
    host?: string | null;
    machineId?: string | null;
  }> | null | undefined) | null;
  getActiveAgentCompositionToolSelection?: (() => AgentCompositionToolSelection | null | undefined) | null;
}>;

export type RunnerMcpSessionWithContext<TSession> = TSession & {
  getSessionRoleContext?: RunnerMcpSessionContextAccessors['getSessionRoleContext'];
  getPluginMcpRuntimeRegistry?: RunnerMcpSessionContextAccessors['getPluginMcpRuntimeRegistry'];
  getPluginMcpPort?: RunnerMcpSessionContextAccessors['getPluginMcpPort'];
  getCurrentSessionSkillItems?: RunnerMcpSessionContextAccessors['getCurrentSessionSkillItems'];
  getCurrentResolvedRoles?: () => ResolvedRolesSnapshotV1;
  readRoleSources?: RoleSourceReader;
  getCurrentWorkspaceWrites?: () => 'allow' | 'deny' | undefined;
  prepareWorkspaceWritesPolicy?: WorkspaceWritesPolicyPreparation;
  getMetadataSnapshot?: () => Metadata | null;
  getPermissionMode?: () => PermissionMode | null | undefined;
  getActiveTurnPermissionWitness?: () => RuntimeActiveTurnPermissionWitness | null | undefined;
  getActiveTurnAdmissionWitness?: () => import('@/plugins/runtime/invocation/services/types').AgentInvocationTurnAdmissionWitness | null;
  getRuntimeLifetimeSignal?: () => AbortSignal | null | undefined;
  getHostTurnAbortSignal?: () => AbortSignal | null | undefined;
  getBackendTarget?: () => PersistedBackendTargetRefV2 | null | undefined;
  getCurrentSessionLocation?: () => Readonly<{
    path?: string | null;
    host?: string | null;
    machineId?: string | null;
  }> | null | undefined;
  getActiveAgentCompositionToolSelection?: () => AgentCompositionToolSelection | null | undefined;
};

export function applyRunnerMcpSessionContext<TSession extends object>(
  session: TSession,
  accessors: RunnerMcpSessionContextAccessors,
): RunnerMcpSessionWithContext<TSession> {
  const target = session as RunnerMcpSessionWithContext<TSession>;
  if (accessors.getSessionRoleContext) target.getSessionRoleContext = accessors.getSessionRoleContext;
  if (accessors.getCurrentSessionSkillItems) target.getCurrentSessionSkillItems = accessors.getCurrentSessionSkillItems;
  if (accessors.getPluginMcpRuntimeRegistry) target.getPluginMcpRuntimeRegistry = accessors.getPluginMcpRuntimeRegistry;
  if (accessors.getPluginMcpPort) target.getPluginMcpPort = accessors.getPluginMcpPort;
  if (accessors.getCurrentResolvedRoles) target.getCurrentResolvedRoles = accessors.getCurrentResolvedRoles;
  if (accessors.readRoleSources) target.readRoleSources = accessors.readRoleSources;
  if (accessors.getCurrentWorkspaceWrites) target.getCurrentWorkspaceWrites = accessors.getCurrentWorkspaceWrites;
  if (accessors.prepareWorkspaceWritesPolicy) target.prepareWorkspaceWritesPolicy = accessors.prepareWorkspaceWritesPolicy;
  if (accessors.getPermissionMode) {
    target.getPermissionMode = accessors.getPermissionMode;
  }
  if (accessors.getActiveTurnPermissionWitness) {
    target.getActiveTurnPermissionWitness = accessors.getActiveTurnPermissionWitness;
  }
  if (accessors.getActiveTurnAdmissionWitness) {
    target.getActiveTurnAdmissionWitness = accessors.getActiveTurnAdmissionWitness;
  }
  if (accessors.getRuntimeLifetimeSignal) {
    target.getRuntimeLifetimeSignal = accessors.getRuntimeLifetimeSignal;
  }
  if (accessors.getHostTurnAbortSignal) {
    target.getHostTurnAbortSignal = accessors.getHostTurnAbortSignal;
  }
  if (accessors.getBackendTarget) {
    target.getBackendTarget = accessors.getBackendTarget;
  }
  if (accessors.getCurrentSessionLocation) {
    target.getCurrentSessionLocation = accessors.getCurrentSessionLocation;
  }
  if (accessors.getActiveAgentCompositionToolSelection) {
    target.getActiveAgentCompositionToolSelection = accessors.getActiveAgentCompositionToolSelection;
  }
  return target;
}
