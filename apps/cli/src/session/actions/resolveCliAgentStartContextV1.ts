import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import type { RoleSourceInventoryV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import type { AccountSettings, AgentStartContextV1, PersistedBackendTargetRefV2, ResolvedRolesSnapshotV1, RoleEngineV1, ProviderBoundModelRef } from '@happier-dev/protocol';
import {
  readAcpSessionModeIntentFromMetadata,
  readAcpConfigOptionIntentFromMetadata,
} from '@happier-dev/agents';
import type { ExecutionRunAppliedParentSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { WorkflowTargetUnavailableReasonV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { actionStartTargetUnavailableV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';

/** Host-produced identity; never accepted from an Action's input payload. */
export type AgentStartRunCallerBinding =
  | Readonly<{ hostSessionId: string; callingRunId: string; callingRunDepth: number }>
  | Readonly<{ runId: string; runDepth: number; runOriginSessionId?: string }>;

/** The same effective engine observation feeds birth and later report copies. */
export function readCliSessionEngineBaselineV1(input: Readonly<{
  backendTarget: PersistedBackendTargetRefV2;
  appliedChildSelection?: Extract<ExecutionRunAppliedParentSelection, { status: 'unavailable' }>
    | Pick<Extract<ExecutionRunAppliedParentSelection, { status: 'applied' }>, 'status' | 'modelId' | 'modelSelection' | 'teamCredentialModel'>;
}>): Readonly<{
  modelSelection: ProviderBoundModelRef | undefined;
  defaultEngine: RoleEngineV1;
}> {
  const agentTargetKey = buildBackendTargetKeyV2(input.backendTarget);
  const applied = input.appliedChildSelection?.status === 'applied' ? input.appliedChildSelection : undefined;
  const modelSelection = applied?.modelSelection ?? (!applied?.teamCredentialModel && applied?.modelId
    ? { agentTargetKey, providerConnectionId: null, modelId: applied.modelId } : undefined);
  return { modelSelection, defaultEngine: { agentTargetKey, ...(modelSelection?.modelId ? { modelId: modelSelection.modelId } : {}) } };
}

/** Adapts existing host snapshots; policy and role precedence remain Protocol-owned. */
export function resolveCliAgentStartContextV1(input: Readonly<{
  sessionId: string;
  machineId: string | null;
  directory: string | null;
  backendTarget: PersistedBackendTargetRefV2 | null;
  metadata: Readonly<Record<string, unknown>> | null;
  appliedChildSelection?: ExecutionRunAppliedParentSelection;
  directParentCustody?: true;
  /** Workflow daemon birth only: resolved child engine, never origin readback. */
  workflowStepRoleDefaultEngine?: RoleEngineV1;
  starterDepth: number | undefined;
  turnDepth: number;
  callerPermissionMode: string | null;
  settings: Pick<AccountSettings, 'workDepthLimit' | 'sessionAgentStartAllowListsV1'> | null;
  accountRoleOverrides?: AccountRoleOverridesReadV1;
  roles?: ResolvedRolesSnapshotV1;
  roleSourceInventory?: RoleSourceInventoryV1;
  availableAgentTargetKeys?: readonly string[];
  runCaller?: AgentStartRunCallerBinding | null;
  recordActionStartDiagnostic?: ActionExecutorContext['recordActionStartDiagnostic'];
}>): AgentStartContextV1 | ReturnType<typeof actionStartTargetUnavailableV1> {
  const ceiling = input.callerPermissionMode ? parseAgentPermissionIntentV1Alias(input.callerPermissionMode) : null;
  const runCaller = input.runCaller;
  const backgroundRun = runCaller && 'hostSessionId' in runCaller ? runCaller : null;
  const workflowRun = runCaller && 'runId' in runCaller ? runCaller : null;
  const starterDepth = backgroundRun?.callingRunDepth ?? workflowRun?.runDepth ?? input.starterDepth;
  const refuse = (reason: WorkflowTargetUnavailableReasonV1) =>
    actionStartTargetUnavailableV1(input, 'agent_start_context', reason);
  if (!input.machineId) return refuse('caller_machine_unavailable');
  if (!input.directory) return refuse('caller_workspace_unavailable');
  if (!input.backendTarget) return refuse('caller_agent_unavailable');
  if (!ceiling) return refuse('caller_permission_unavailable');
  if (starterDepth === undefined || !Number.isSafeInteger(starterDepth) || starterDepth < 0
    || !Number.isSafeInteger(input.turnDepth) || input.turnDepth < 0) return refuse('caller_depth_unavailable');
  if ((backgroundRun && (backgroundRun.hostSessionId !== input.sessionId || !backgroundRun.callingRunId.trim()))
    || (workflowRun && !workflowRun.runId.trim())) return refuse('caller_run_unavailable');
  // Detached steps have no Session configuration to inherit.
  const metadata = workflowRun ? {} : input.metadata ?? {};
  const applied = !workflowRun && input.appliedChildSelection?.status === 'applied' ? input.appliedChildSelection : undefined;
  const { modelSelection: model, defaultEngine: engineBaseline } = readCliSessionEngineBaselineV1({ backendTarget: input.backendTarget,
    appliedChildSelection: applied });
  const defaultEngine = applied || workflowRun ? engineBaseline : input.workflowStepRoleDefaultEngine;
  // Agent-start's released baseline cannot represent Team model custody. Leave
  // it omitted so attached admission reads the opened Team source, never a
  // fabricated native reference with the same model id.
  const mode = readAcpSessionModeIntentFromMetadata(metadata)?.modeId ?? undefined;
  const configKeys = new Set([metadata.sessionConfigOptionOverridesV1, metadata.acpConfigOptionOverridesV1]
    .flatMap((value) => value && typeof value === 'object' && 'overrides' in value && value.overrides && typeof value.overrides === 'object'
      ? Object.keys(value.overrides) : []));
  const configOptions = Object.fromEntries([...configKeys].flatMap((key) => {
    const selection = readAcpConfigOptionIntentFromMetadata(metadata, key);
    return selection ? [[key, { value: selection.value, updatedAtMs: selection.updatedAt }]] : [];
  }));
  const sessionRoles = readSessionRolesV1(metadata) ?? undefined;
  const roles: Record<string, ResolvedRolesSnapshotV1[string]> = { ...input.roles };
  if (!input.roles) {
    if (input.roleSourceInventory?.status !== 'ready') return refuse('role_source_incomplete');
    if (input.accountRoleOverrides?.status !== 'ready') return refuse('role_overrides_unavailable');
    const roleInputs = { sessionRoles, roleSourceInventory: input.roleSourceInventory,
      settingsOverrides: input.accountRoleOverrides.overrides,
      defaultEngine,
    };
    // Frozen fields are authoritative even without a running native owner.
    // Check completeness before availability filtering can hide an unfrozen
    // Role. Pending metadata or an implicit engine cannot fill that gap.
    if (!defaultEngine && Object.values(resolveRolesSnapshotV1(roleInputs)).some(role => !role.engine)) {
      return refuse('caller_agent_unavailable');
    }
    Object.assign(roles, resolveRolesSnapshotV1({ ...roleInputs,
      availableAgentTargetKeys: input.availableAgentTargetKeys,
    }));
  }
  return {
    caller: workflowRun
      ? { kind: 'originless', runId: workflowRun.runId, runDepth: workflowRun.runDepth,
        ...(workflowRun.runOriginSessionId ? { runOriginSessionId: workflowRun.runOriginSessionId } : {}) }
      : { kind: 'session', sessionId: input.sessionId, starterDepth, turnDepth: input.turnDepth },
    baseline: { machineId: input.machineId, directory: input.directory,
      ...(input.directParentCustody && !workflowRun ? { directParentCustody: true } : {}),
      ...(applied ? { configuration: {
      agentTarget: input.backendTarget, modelSelection: model, permissionMode: ceiling,
      agentModeId: mode, configOptions,
      ...(typeof metadata.profileId === 'string' ? { profileId: metadata.profileId } : {}),
      connectedServices: applied.teamCredentialModel ? undefined : applied.connectedServices,
      capabilitySelection: readSessionCapabilitySelectionFromMetadataV1(metadata),
      ...(metadata.transcriptStorage === 'direct' || metadata.transcriptStorage === 'persisted' ? { transcriptStorage: metadata.transcriptStorage } : {}),
    } } : {}) },
    ledSubtreeSessionIds: [], roles, callerPermissionCeiling: ceiling,
    workDepthLimit: input.settings?.workDepthLimit ?? 4,
    allowLists: input.settings?.sessionAgentStartAllowListsV1,
  };
}
