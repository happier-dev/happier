import { BUILT_IN_ROLE_IDS_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { readSessionMcpSelectionV1FromMetadata } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import type { AccountSettings, AgentStartContextV1, BackendTargetRefV2, ResolvedRolesSnapshotV1, RoleArtifactV1 } from '@happier-dev/protocol';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import {
  resolveModelSelectionIntentFromSessionMetadata, readAcpSessionModeIntentFromMetadata,
  readAcpConfigOptionIntentFromMetadata,
} from '@happier-dev/agents';

/** Host-produced identity; never accepted from an Action's input payload. */
export type AgentStartRunCallerBinding =
  | Readonly<{ hostSessionId: string; callingRunId: string; callingRunDepth: number }>
  | Readonly<{ runId: string; runDepth: number; runOriginSessionId?: string }>;

/** Adapts existing host snapshots; policy and role precedence remain Protocol-owned. */
export function resolveCliAgentStartContextV1(input: Readonly<{
  sessionId: string;
  machineId: string | null;
  directory: string | null;
  backendTarget: BackendTargetRefV2 | null;
  metadata: Readonly<Record<string, unknown>> | null;
  starterDepth: number | undefined;
  turnDepth: number;
  callerPermissionMode: string | null;
  settings: AccountSettings | null;
  roles?: ResolvedRolesSnapshotV1;
  settingsRoles?: Readonly<Record<string, RoleArtifactV1>>;
  availableAgentTargetKeys?: readonly string[];
  runCaller?: AgentStartRunCallerBinding | null;
}>): AgentStartContextV1 | null {
  const ceiling = input.callerPermissionMode ? parseAgentPermissionIntentV1Alias(input.callerPermissionMode) : null;
  const runCaller = input.runCaller;
  const backgroundRun = runCaller && 'hostSessionId' in runCaller ? runCaller : null;
  const workflowRun = runCaller && 'runId' in runCaller ? runCaller : null;
  const starterDepth = backgroundRun?.callingRunDepth ?? workflowRun?.runDepth ?? input.starterDepth;
  if (!input.machineId || !input.directory || !input.backendTarget || !ceiling
    || starterDepth === undefined || !Number.isSafeInteger(starterDepth) || starterDepth < 0
    || (backgroundRun && (backgroundRun.hostSessionId !== input.sessionId || !backgroundRun.callingRunId.trim()))
    || (workflowRun && !workflowRun.runId.trim())
    || !Number.isSafeInteger(input.turnDepth) || input.turnDepth < 0) return null;
  // Detached steps have no Session configuration to inherit.
  const metadata = workflowRun ? {} : input.metadata ?? {};
  const agentTargetKey = buildBackendTargetKeyV2(input.backendTarget);
  const model = resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey)?.selection ?? undefined;
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
  if (!input.roles || input.settingsRoles) {
    for (const roleId of new Set([...BUILT_IN_ROLE_IDS_V1, ...Object.keys(input.settingsRoles ?? {}), ...Object.keys(sessionRoles?.sessionRoles ?? {}), ...Object.keys(input.settings?.rolesV1.overrides ?? {})])) {
      const resolved = resolveRoleSelectionV1({ roleId, sessionRoles,
        settingsRoles: input.settingsRoles,
        settingsOverrides: input.settings?.rolesV1.overrides,
        defaultEngine: { agentTargetKey, ...(model ? { modelId: model.modelId } : {}) },
        availableAgentTargetKeys: input.availableAgentTargetKeys,
      });
      if (resolved.ok) roles[roleId] = resolved.selection;
      else delete roles[roleId];
    }
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
      connectedServices: connectedServices.success ? connectedServices.data : undefined,
      mcpSelection: readSessionMcpSelectionV1FromMetadata(metadata) ?? undefined,
      ...(metadata.transcriptStorage === 'direct' || metadata.transcriptStorage === 'persisted' ? { transcriptStorage: metadata.transcriptStorage } : {}),
    } } : {}) },
    ledSubtreeSessionIds: [], roles, callerPermissionCeiling: ceiling,
    workDepthLimit: input.settings?.workDepthLimit ?? 4,
    allowLists: input.settings?.sessionAgentStartAllowListsV1,
  };
}
