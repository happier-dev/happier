import type { ActionId } from '../../actions/actionIds.js';
import type { WorkflowSessionAuthoringSelectionFieldId } from '../../workflows/workflowV1.js';

export type ExistingSessionFieldApplication =
  | Readonly<{ via: 'message' }>
  | Readonly<{ via: 'action'; actionId: ActionId }>
  | Readonly<{ via: 'transition' }>
  | Readonly<{ via: 'unsupported'; reason: 'new_sessions_only' }>;

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
  connectedServices: { via: 'action', actionId: 'session.connected_services_auth.set' },
  capabilitySelection: { via: 'action', actionId: 'session.capabilities.set' },
  transcriptStorage: { via: 'unsupported', reason: 'new_sessions_only' },
  terminal: { via: 'unsupported', reason: 'new_sessions_only' },
  windowsRemoteSessionLaunchMode: { via: 'unsupported', reason: 'new_sessions_only' },
  windowsRemoteSessionConsole: { via: 'unsupported', reason: 'new_sessions_only' },
  windowsTerminalWindowName: { via: 'unsupported', reason: 'new_sessions_only' },
  runtimeDescriptorV1: { via: 'unsupported', reason: 'new_sessions_only' },
} as const satisfies Record<WorkflowSessionAuthoringSelectionFieldId, ExistingSessionFieldApplication>;
