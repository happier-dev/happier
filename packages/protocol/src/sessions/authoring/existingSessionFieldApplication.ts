import { SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1, type ActionId } from '../../actions/actionIds.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';
import type { AgentExecutionTargetV1 } from '../../agents/executionTargetV1.js';
import { formatLegacyConfiguredAcpAgentId, readLegacyConfiguredAcpBackendId } from '../../backends/targets/compat/customAcp.js';
import { buildQualifiedPluginContributionKey } from '../../plugins/contributionKey.js';
import type { SessionCapabilitiesSetInputV1 } from '../../actions/specs/sessionCapabilities.js';
import type { WorkflowSessionAuthoringSelection, WorkflowSessionAuthoringSelectionFieldId } from '../../workflows/workflowV1.js';

export type ExistingSessionFieldApplication =
  | Readonly<{ via: 'message' }>
  | Readonly<{ via: 'action'; actionId: ActionId }>
  | Readonly<{ via: 'transition' }>
  | Readonly<{ via: 'unsupported'; reason: 'new_sessions_only' }>;

export type ExistingSessionCapabilityDelta = Readonly<Pick<SessionCapabilitiesSetInputV1, 'kind' | 'id' | 'state'>>;

/** Existing sessions accept item intent. The complete selection belongs to new-session authoring. */
export type ExistingSessionChangeSet = Omit<WorkflowSessionAuthoringSelection, 'capabilitySelection'> & Readonly<{
  capabilityDeltas?: readonly ExistingSessionCapabilityDelta[];
}>;

/** Application capability, independent of a caller's policy (workflows retain their reuse policy). */
export const EXISTING_SESSION_FIELD_APPLICATIONS = {
  allowedTools: { via: 'unsupported', reason: 'new_sessions_only' },
  unlistedTools: { via: 'unsupported', reason: 'new_sessions_only' },
  approvalProfileId: { via: 'unsupported', reason: 'new_sessions_only' },
  profileId: { via: 'unsupported', reason: 'new_sessions_only' },
  agentTarget: { via: 'transition' },
  modelSelection: { via: 'message' },
  permissionMode: { via: 'message' },
  acpSessionModeId: { via: 'action', actionId: 'session.mode.set' },
  sessionConfigOptionOverrides: { via: 'action', actionId: 'session.config_option.set' },
  connectedServices: { via: 'action', actionId: SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1 },
  // The authoring field contributes capabilityDeltas to an ExistingSessionChangeSet.
  capabilitySelection: { via: 'action', actionId: 'session.capabilities.set' },
  transcriptStorage: { via: 'unsupported', reason: 'new_sessions_only' },
  terminal: { via: 'unsupported', reason: 'new_sessions_only' },
  windowsRemoteSessionLaunchMode: { via: 'unsupported', reason: 'new_sessions_only' },
  windowsRemoteSessionConsole: { via: 'unsupported', reason: 'new_sessions_only' },
  windowsTerminalWindowName: { via: 'unsupported', reason: 'new_sessions_only' },
  runtimeDescriptorV1: { via: 'unsupported', reason: 'new_sessions_only' },
} as const satisfies Record<WorkflowSessionAuthoringSelectionFieldId, ExistingSessionFieldApplication>;

/** The existing transition wire identifies configured instances by their definition. */
export function buildExistingSessionTransitionAgentId(target: AgentExecutionTargetV1): string {
  return target.definitionId === undefined ? buildQualifiedPluginContributionKey(target.identity)
    : formatLegacyConfiguredAcpAgentId(target.definitionId);
}

export function resolveExistingSessionAgentTargetApplication(
  selection: AgentExecutionTargetV1 | null | undefined,
  currentAgentIds: readonly (string | null)[],
): Readonly<{ via: 'keep' } | { via: 'transition'; agentId: string } | { via: 'unavailable'; reason: 'target_unavailable' }> {
  if (selection === undefined) return { via: 'keep' };
  if (selection === null) return { via: 'unavailable', reason: 'target_unavailable' };
  const agentId = buildExistingSessionTransitionAgentId(selection);
  if (currentAgentIds.every(current => current === agentId)) return { via: 'keep' };
  if (!AgentIdV1Schema.safeParse(agentId).success
    || (selection.definitionId !== undefined && readLegacyConfiguredAcpBackendId(agentId) !== selection.definitionId)
    || currentAgentIds.some(current => current !== null && !AgentIdV1Schema.safeParse(current).success)) {
    return { via: 'unavailable', reason: 'target_unavailable' };
  }
  return { via: 'transition', agentId };
}
