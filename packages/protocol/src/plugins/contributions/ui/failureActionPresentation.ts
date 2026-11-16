import type { ServiceHealthNoticeMachineV1 } from '../../../activity/accountNoticePageV1.js';
import type { WorkspaceAddressV1 } from '../../../workspaces/workspaceRefV1.js';
import type { JsonValue } from '../../../json/strictJsonValue.js';

/** Data for the existing native placement presenter; it grants no execution authority. */
export type FailureActionPlacement = Readonly<{
  machine?: ServiceHealthNoticeMachineV1;
  workspace?: WorkspaceAddressV1;
  agentTargetKey?: string;
}>;

/** The existing split control's presentation, decided by its contributing Action. */
export type FailureAgentAction = Readonly<{
  actionId: string; label: string; titleKey?: string;
  launchMode: 'start' | 'review'; startable: boolean;
}>;

/** Native presenters consume these UI states without interpreting a plugin's domain result. */
export type FailureActionOutcome =
  | Readonly<{ kind: 'started'; handoff?: JsonValue }>
  | Readonly<{ kind: 'approval'; artifactId: string }>
  | Readonly<{ kind: 'selectionRequired'; fields: readonly string[] }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{ kind: 'unavailable'; code: string; configuredActionId?: string;
      recovery?: 'configure'; handoff?: JsonValue; detail?: JsonValue }>
  | Readonly<{ kind: 'placement_choice_required'; reason:
      'controller_required' | 'machine_unreachable' | 'ambiguous_workspace' | 'agent_required';
      candidates: readonly Readonly<{ machine: ServiceHealthNoticeMachineV1; workspace?: WorkspaceAddressV1; reachable: boolean }>[];
      agents: readonly Readonly<{ targetKey: string; label: string }>[] }>;
