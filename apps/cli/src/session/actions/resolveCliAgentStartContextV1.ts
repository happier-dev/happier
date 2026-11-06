import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import type { RoleSourceInventoryV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import type { AccountSettings, AgentStartContextV1, BackendTargetRefV2, ResolvedRolesSnapshotV1, PersistedBackendTargetRefV2, RoleEngineV1, ProviderBoundModelRef } from '@happier-dev/protocol';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import {
  resolveModelSelectionIntentFromSessionMetadata, readAcpSessionModeIntentFromMetadata,
  readAcpConfigOptionIntentFromMetadata,
} from '@happier-dev/agents';
import type { ExecutionRunAppliedParentSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { WorkflowTargetUnavailableReasonV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

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
  backendTarget: BackendTargetRefV2 | null;
  metadata: Readonly<Record<string, unknown>> | null;
  appliedChildSelection?: ExecutionRunAppliedParentSelection;
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
}>): AgentStartContextV1 | null {
  const ceiling = input.callerPermissionMode ? parseAgentPermissionIntentV1Alias(input.callerPermissionMode) : null;
  const runCaller = input.runCaller;
  const backgroundRun = runCaller && 'hostSessionId' in runCaller ? runCaller : null;
  const workflowRun = runCaller && 'runId' in runCaller ? runCaller : null;
  const starterDepth = backgroundRun?.callingRunDepth ?? workflowRun?.runDepth ?? input.starterDepth;
  const refuse = (reason: WorkflowTargetUnavailableReasonV1) => {
    input.recordActionStartDiagnostic?.({ phase: 'agent_start_context', refusalReason: reason });
    return null;
  };
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
  const agentTargetKey = buildBackendTargetKeyV2(input.backendTarget);
  const applied = !workflowRun && input.appliedChildSelection?.status === 'applied' ? input.appliedChildSelection : undefined;
  const model = input.appliedChildSelection !== undefined
    ? applied?.modelSelection ?? (!applied?.teamCredentialModel && applied?.modelId
      ? { agentTargetKey, providerConnectionId: null, modelId: applied.modelId } : undefined)
    : resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey)?.selection ?? undefined;
  // Agent-start's released baseline cannot represent Team model custody. Leave
  // it omitted so attached admission reads the opened Team source, never a
  // fabricated native reference with the same model id.
  const selectedModelId = model?.modelId;
  const mode = readAcpSessionModeIntentFromMetadata(metadata)?.modeId ?? undefined;
  const configKeys = new Set([metadata.sessionConfigOptionOverridesV1, metadata.acpConfigOptionOverridesV1]
    .flatMap((value) => value && typeof value === 'object' && 'overrides' in value && value.overrides && typeof value.overrides === 'object'
      ? Object.keys(value.overrides) : []));
  const configOptions = Object.fromEntries([...configKeys].flatMap((key) => {
    const selection = readAcpConfigOptionIntentFromMetadata(metadata, key);
    return selection ? [[key, { value: selection.value, updatedAtMs: selection.updatedAt }]] : [];
  }));
  const sessionRoles = readSessionRolesV1(metadata) ?? undefined;
  const connectedServices = SessionSpawnNewInputV2Schema.shape.connectedServices.safeParse(metadata.connectedServices);
  const roles: Record<string, ResolvedRolesSnapshotV1[string]> = { ...input.roles };
  if (!input.roles) {
    if (input.roleSourceInventory?.status !== 'ready') return refuse('role_source_incomplete');
    if (input.accountRoleOverrides?.status !== 'ready') return refuse('role_overrides_unavailable');
    Object.assign(roles, resolveRolesSnapshotV1({ sessionRoles, roleSourceInventory: input.roleSourceInventory,
      settingsOverrides: input.accountRoleOverrides.overrides,
      defaultEngine: { agentTargetKey, ...(selectedModelId ? { modelId: selectedModelId } : {}) },
      availableAgentTargetKeys: input.availableAgentTargetKeys,
    }));
  }
  return {
    caller: workflowRun
      ? { kind: 'originless', runId: workflowRun.runId, runDepth: workflowRun.runDepth,
        ...(workflowRun.runOriginSessionId ? { runOriginSessionId: workflowRun.runOriginSessionId } : {}) }
      : { kind: 'session', sessionId: input.sessionId, starterDepth, turnDepth: input.turnDepth },
    baseline: { machineId: input.machineId, directory: input.directory, ...(!workflowRun ? { configuration: {
      agentTarget: input.backendTarget, modelSelection: model, permissionMode: ceiling,
      agentModeId: mode, configOptions,
      ...(typeof metadata.profileId === 'string' ? { profileId: metadata.profileId } : {}),
      connectedServices: (input.appliedChildSelection !== undefined ? applied?.teamCredentialModel ? undefined : applied?.connectedServices
        : connectedServices.success ? connectedServices.data : undefined),
      capabilitySelection: readSessionCapabilitySelectionFromMetadataV1(metadata),
      ...(metadata.transcriptStorage === 'direct' || metadata.transcriptStorage === 'persisted' ? { transcriptStorage: metadata.transcriptStorage } : {}),
    } } : {}) },
    ledSubtreeSessionIds: [], roles, callerPermissionCeiling: ceiling,
    workDepthLimit: input.settings?.workDepthLimit ?? 4,
    allowLists: input.settings?.sessionAgentStartAllowListsV1,
  };
}
