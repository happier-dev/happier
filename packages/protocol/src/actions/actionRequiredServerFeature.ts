import type { FeatureId } from '../features/catalog.js';
import { ACTION_ID_FAMILIES_V1, WorkflowActionIdV1Schema, isSessionAccessActionId } from './actionIds.js';
import { isSessionBoardActionIdV1 } from '../sessions/board/actionIds.js';
import { isSessionDiscussionActionIdV1 } from '../sessions/discussions/actionIds.js';
import { TeamCredentialActionIdV1Schema } from '../teams/credentials/actionsV1.js';
import { TeamActionIdV1Schema } from '../teams/actionsV1.js';
import { isSessionFollowActionIdV1 } from '../sessions/follow/actions.js';
import { MachinePoolActionIdV1Schema } from '../machines/pools/actionsV1.js';
import { EphemeralRunnerActionIdV1Schema } from '../ephemeralRunner/actionIdsV1.js';
import { isRemoteHostActionIdV1 } from '../remoteHosts/remoteHostActionIdsV1.js';

// Native navigation mutates the page just like the automation family. Human
// sidecar commands are a separate entry point, not automation Actions.
const browserAutomationActionIds: ReadonlySet<string> = new Set([
  ...ACTION_ID_FAMILIES_V1.browser_automation,
  'browser.navigate', 'browser.goBack', 'browser.goForward', 'browser.reload', 'browser.stop',
]);

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
  if (isRemoteHostActionIdV1(actionId)) return 'remoteHosts.management';
  if (browserAutomationActionIds.has(actionId)) return 'browser.automation';
  if (actionId.startsWith('artifact.public_link.')) return 'sharing.public';
  if (WorkflowActionIdV1Schema.safeParse(actionId).success) return 'workflows';
  if (isSessionBoardActionIdV1(actionId)) return 'sessions.board';
  if (isSessionDiscussionActionIdV1(actionId)) return 'sessions.conversations';
  if (TeamCredentialActionIdV1Schema.safeParse(actionId).success) {
    return actionId.startsWith('teams.credentials.externalKeys.')
      ? 'teams.credentialResources.externalApi'
      : 'teams.credentialResources';
  }
  // Team governance depends on Teams. Saved Secret resources are Account-owned;
  // only an operation's actual Team audience depends on the Team service gate.
  if (TeamActionIdV1Schema.safeParse(actionId).success) return 'teams';
  if (isSessionFollowActionIdV1(actionId)) return 'sessions.following';
  if (isSessionAccessActionId(actionId)) {
    // The public-link intents are served by the public-share routes, whose
    // availability owner is `sharing.public`; the grant, context and
    // responsibility intents are the collaboration routes, served wherever
    // `sharing.session` is enabled.
    return actionId.startsWith('session.public_link.') ? 'sharing.public' : 'sharing.session';
  }
  if (MachinePoolActionIdV1Schema.safeParse(actionId).success) return 'machines.pools';
  if (EphemeralRunnerActionIdV1Schema.safeParse(actionId).success) return 'sessions.ephemeralRunner';
  return null;
}
