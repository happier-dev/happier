import type { FeatureId } from '../features/catalog.js';
import { ACTION_ID_FAMILIES_V1, WORKFLOW_ACTION_IDS_V1, isSessionAccessActionId } from './actionIds.js';
import { isSessionDiscussionActionIdV1 } from '../sessions/discussions/actionIds.js';
import { TEAM_CREDENTIAL_ACTION_IDS_V1 } from '../teams/credentials/actionIdsV1.js';
import { TEAM_ACTION_IDS_V1 } from '../teams/actionsV1.js';
import { isSessionFollowActionIdV1 } from '../sessions/follow/actions.js';
import { MACHINE_POOL_ACTION_IDS_V1 } from '../machines/pools/actionsV1.js';
import { EPHEMERAL_RUNNER_ACTION_IDS_V1 } from '../ephemeralRunner/actionIdsV1.js';
import { isRemoteHostActionIdV1 } from '../remoteHosts/remoteHostActionIdsV1.js';

// Native navigation mutates the page just like the automation family. Human
// sidecar commands are a separate entry point, not automation Actions.
const browserAutomationActionIds: ReadonlySet<string> = new Set([
  ...ACTION_ID_FAMILIES_V1.browser_automation,
  'browser.navigate', 'browser.goBack', 'browser.goForward', 'browser.reload', 'browser.stop',
]);

// These are the same owner-declared vocabularies used by the enum schemas.
// Membership misses are ordinary catalog branching, not validation failures:
// parsing them would construct five Zod errors for every unrelated Action.
const workflowActionIds: readonly string[] = WORKFLOW_ACTION_IDS_V1;
const teamCredentialActionIds: readonly string[] = TEAM_CREDENTIAL_ACTION_IDS_V1;
const teamActionIds: readonly string[] = TEAM_ACTION_IDS_V1;
const machinePoolActionIds: readonly string[] = MACHINE_POOL_ACTION_IDS_V1;
const ephemeralRunnerActionIds: readonly string[] = EPHEMERAL_RUNNER_ACTION_IDS_V1;

/**
 * The canonical server feature each gated Action family depends on.
 *
 * An Action row declares what an intent is; it does not declare whether the
 * exact target Home can serve it. Hosts that advertise or admit Actions —
 * catalogs, tool projections, MCP enablement — must intersect the shared
 * Actions policy with this feature, resolved against that Home's own decision.
 * Keeping the family→feature fact here stops each host from growing its own
 * id-to-feature branch and drifting when a family is added.
 *
 * Effect-time access, currentness and encryption readiness remain owned by each
 * Action adapter; this is availability only.
 */
export function getActionRequiredServerFeatureId(actionId: string): FeatureId | null {
  // Device-local trust withdrawal and resource cleanup do not use the Home's
  // management service, and must remain available after that service is disabled.
  if (actionId === 'remote_hosts.trusted_keys.list' || actionId === 'remote_hosts.trusted_keys.remove'
    || actionId === 'remote_hosts.trusted_keys.clear' || actionId === 'remote_hosts.tunnel.stop') return null;
  if (isRemoteHostActionIdV1(actionId)) return 'remoteHosts.management';
  if (browserAutomationActionIds.has(actionId)) return 'browser.automation';
  if (actionId.startsWith('artifact.public_link.')) return 'sharing.public';
  if (workflowActionIds.includes(actionId)) return 'workflows';
  // Item Actions also serve transcript visuals; their operands decide layout
  // admission at execution. Only the layout-only Action is Board availability.
  if (actionId === 'session.board.layout.update') return 'sessions.board';
  if (isSessionDiscussionActionIdV1(actionId)) return 'sessions.conversations';
  if (teamCredentialActionIds.includes(actionId)) {
    return actionId.startsWith('teams.credentials.externalKeys.')
      ? 'teams.credentialResources.externalApi'
      : 'teams.credentialResources';
  }
  // Team governance depends on Teams. Saved Secret resources are Account-owned;
  // only an operation's actual Team audience depends on the Team service gate.
  if (teamActionIds.includes(actionId)) return 'teams';
  if (isSessionFollowActionIdV1(actionId)) return 'sessions.following';
  if (isSessionAccessActionId(actionId)) {
    // The public-link intents are served by the public-share routes, whose
    // availability owner is `sharing.public`; the grant, context and
    // responsibility intents are the collaboration routes, served wherever
    // `sharing.session` is enabled.
    return actionId.startsWith('session.public_link.') ? 'sharing.public' : 'sharing.session';
  }
  if (machinePoolActionIds.includes(actionId)) return 'machines.pools';
  if (ephemeralRunnerActionIds.includes(actionId)) return 'sessions.ephemeralRunner';
  return null;
}
