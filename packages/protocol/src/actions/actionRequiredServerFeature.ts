import type { FeatureId } from '../features/catalog.js';
import { ACTION_ID_FAMILIES_V1, WORKFLOW_ACTION_IDS_V1, isSessionAccessActionId } from './actionIds.js';
import { isDiscussionActionIdV1 } from '../discussions/actionIds.js';
import { TEAM_CREDENTIAL_ACTION_IDS_V1 } from '../teams/credentials/actionIdsV1.js';
import { TEAM_ACTION_IDS_V1 } from '../teams/actionsV1.js';
import { isSessionFollowActionIdV1 } from '../sessions/follow/actions.js';
import { MACHINE_POOL_ACTION_IDS_V1 } from '../machines/pools/actionsV1.js';
import { EPHEMERAL_RUNNER_ACTION_IDS_V1 } from '../ephemeralRunner/actionIdsV1.js';
import { isRemoteHostActionIdV1 } from '../remoteHosts/remoteHostActionIdsV1.js';
import type { ActionExecutorContext } from './executor/types.js';
import { isDeploymentActionIdV1 } from '../deployments/deploymentActionIdsV1.js';

// The same navigation Action serves Agent automation and present-human UI
// browsing. Trusted execution context distinguishes those capability tiers.
const browserNavigationActionIds: ReadonlySet<string> = new Set([
  'browser.navigate', 'browser.goBack', 'browser.goForward', 'browser.reload', 'browser.stop',
]);
const browserAutomationActionIds: ReadonlySet<string> = new Set(ACTION_ID_FAMILIES_V1.browser_automation);

// These are the same owner-declared vocabularies used by the enum schemas.
// Membership misses are ordinary catalog branching, not validation failures:
// parsing them would construct five Zod errors for every unrelated Action.
const workflowActionIds: readonly string[] = WORKFLOW_ACTION_IDS_V1;
const teamCredentialActionIds: readonly string[] = TEAM_CREDENTIAL_ACTION_IDS_V1;
const teamActionIds: readonly string[] = TEAM_ACTION_IDS_V1;
const machinePoolActionIds: readonly string[] = MACHINE_POOL_ACTION_IDS_V1;
const ephemeralRunnerActionIds: readonly string[] = EPHEMERAL_RUNNER_ACTION_IDS_V1;

/** Account opt-outs stop new work, while existing resources keep their service access. */
export function getActionNewWorkFeatureId(
  actionId: string,
  context?: Readonly<Pick<ActionExecutorContext, 'surface' | 'authority'>>,
  input?: unknown,
): FeatureId | null {
  const requiredFeature = getActionRequiredServerFeatureId(actionId, context, input);
  if (requiredFeature === 'deployments' || requiredFeature === 'bots') return requiredFeature;
  switch (actionId) {
    case 'discussion.create': case 'discussion.second_opinion.start':
    case 'teams.create': case 'follow.set':
      return requiredFeature;
    case 'workflow.run.start': case 'workflow.definition.create':
    case 'workflow.definition.import': case 'workflow.definition.capture':
    case 'workflow.trigger.add': case 'workflow.trigger.run_now':
    case 'session.trigger.add':
      return requiredFeature;
    case 'execution.run.start': case 'execution.run.ensure_or_start':
    case 'review.start': case 'review.apply': case 'review.walkthrough': case 'review.explain_findings':
    case 'subagents.plan.start': case 'subagents.delegate.start':
      return 'execution.runs';
    case 'voice_agent.start':
      return 'voice.agent';
    case 'session.terminals.open': case 'session.terminals.split':
    case 'session.terminals.restart': case 'session.terminals.run_script':
      return 'terminal.embeddedPty';
    case 'memory.search':
      return 'memory.search';
    case 'sessions.external.link.ensure': case 'sessions.external.follow':
    case 'sessions.external.takeover': case 'sessions.external.takeover.start':
    case 'sessions.external.materialize.start':
      return 'sessions.direct';
    case 'scm.change.include': case 'scm.change.exclude': case 'scm.change.discard':
    case 'scm.suggestion.apply': case 'scm.commit.create': case 'scm.commit.backout': case 'scm.commit.undoLast':
    case 'scm.branch.create': case 'scm.branch.checkout': case 'scm.branch.merge': case 'scm.branch.rebase':
    case 'scm.branch.operation.continue': case 'scm.branch.operation.skip':
    case 'scm.conflict.acceptSide': case 'scm.conflict.markResolved': case 'scm.worktree.create':
    case 'scm.remote.add': case 'scm.remote.setUrl': case 'scm.remote.fetch': case 'scm.remote.pull':
    case 'scm.remote.push': case 'scm.remote.publish': case 'scm.stash.create': case 'scm.stash.apply': case 'scm.stash.pop':
    case 'scm.pullRequest.openOrReuse': case 'scm.pullRequest.checkout': case 'scm.pullRequest.prepareWorktree':
    case 'scm.reviewWorkspace.materializePrepared': case 'scm.pullRequest.runStacked':
    case 'scm.repository.clone': case 'scm.repository.init': case 'scm.hostingRepository.publish':
      return 'scm.writeOperations';
    case 'browser.view.open': case 'browser.workspace.open':
      return 'browser';
    case 'devices.simulator.lease.acquire':
      return 'devices';
    default:
      return null;
  }
}

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
export function getActionRequiredServerFeatureId(
  actionId: string,
  context?: Readonly<Pick<ActionExecutorContext, 'surface' | 'authority'>>,
  input?: unknown,
): FeatureId | null {
  // Admission only. Inspection and withdrawal remain available after opt-out.
  if (isDeploymentActionIdV1(actionId)) {
    switch (actionId) {
      case 'deployments.domains.get': case 'deployments.domains.list': case 'deployments.domains.remove':
      case 'deployments.targets.unlink': case 'deployments.environments.delete':
      case 'deployments.teardown': case 'deployments.cancel':
      case 'deployments.environments.get': case 'deployments.environments.list':
      case 'deployments.receipts.get': case 'deployments.receipts.list': case 'deployments.receipts.observe':
      case 'deployments.health.read': case 'deployments.health.current': case 'deployments.drift.read': case 'deployments.logs.read':
        return null;
      default: return 'deployments';
    }
  }
  if (actionId === 'session.bot.set') {
    return input !== null && typeof input === 'object' && Reflect.get(input, 'bot') === null ? null : 'bots';
  }
  if (actionId === 'session.bot.face.set') return 'bots';
  if (actionId === 'template.draft' || actionId === 'template.release'
    || actionId === 'template.instantiate' || actionId === 'template.updates.apply') return 'bots';
  // Device-local trust withdrawal and resource cleanup do not use the Home's
  // management service, and must remain available after that service is disabled.
  if (actionId === 'remote_hosts.trusted_keys.list' || actionId === 'remote_hosts.trusted_keys.remove'
    || actionId === 'remote_hosts.trusted_keys.clear' || actionId === 'remote_hosts.tunnel.stop') return null;
  if (isRemoteHostActionIdV1(actionId)) return 'remoteHosts.management';
  if ((ACTION_ID_FAMILIES_V1.session_agent_transition as readonly string[]).includes(actionId)) return 'sessions.agentSwitching';
  const presentHumanUi = context?.surface === 'ui' && context.authority === 'present_user';
  if (browserAutomationActionIds.has(actionId) || (browserNavigationActionIds.has(actionId) && !presentHumanUi)) {
    return 'browser.automation';
  }
  if (actionId === 'artifact.public_link.join') return null;
  if (actionId.startsWith('artifact.public_link.')) return 'sharing.public';
  if (workflowActionIds.includes(actionId)) return 'workflows';
  // Item Actions also serve transcript visuals; their operands decide layout
  // admission at execution. Only the layout-only Action is Board availability.
  if (actionId === 'session.board.layout.update') return 'sessions.board';
  if (isDiscussionActionIdV1(actionId)) return 'sessions.conversations';
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
