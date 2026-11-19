import type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type {
  DeploymentContentV1,
  DeploymentEnvironmentContentV1,
  DeploymentMachineResultV1,
  DeploymentReceiptFailureV1,
  DeploymentReceiptDetailV1,
  DeploymentStepV1,
} from '@happier-dev/deployment-protocol/v1';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { t } from '@/text';
import type { DeploymentActorPresentation } from './useDeploymentActorPresentations';
import { readDeploymentRefusal } from './deploymentActionOutcome';
import { readDeploymentRefusalRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { deploymentRevisionLabelV1 as deploymentRevisionLabel } from '@happier-dev/deployments';
export { deploymentRevisionLabel };

/** Read failures carry Home transport and authority codes from their owners. */
export function deploymentReadIssue(code: string | null | undefined): 'homeUnreachable' | 'withdrawn' | 'readFailed' {
  switch (code) {
    case 'home_unreachable':
    case 'server_unreachable':
      return 'homeUnreachable';
    case 'access_denied':
    case 'deployment_access_denied':
    case 'source_access_denied':
    case 'authority_changed':
      return 'withdrawn';
    default:
      return 'readFailed';
  }
}

/** The Action's reason remains visible beside the next useful step; this never retries or re-authorizes. */
export function deploymentActionRefusalRemedy(code: string): string {
  if (code === 'deployment_conflict' || code === 'host_retired' || code === 'action_account_scope_changed')
    return t('projects.deployments.copy.refresh');
  switch (readDeploymentRefusal(code).reason) {
    case 'permission': return t('projects.deployments.copy.permission');
    case 'machine': return t('projects.deployments.copy.machine');
    case 'repository': return t('projects.deployments.copy.repository');
    case 'unsupported': return t('projects.deployments.copy.unsupported');
    case 'other': return t('projects.deployments.copy.retry');
  }
}

type ReceiptState = DeploymentReceiptHeaderV1['state'];

/** Present the succeeded stored receipt supported by the native image promotion producer. */
export function canPromoteDeploymentReceipt(
  receipt: Pick<DeploymentReceiptDetailV1, 'deployment' | 'content'>,
  environment: DeploymentEnvironmentReadDetailV1 | null,
): boolean {
  return receipt.deployment.state === 'succeeded' && receipt.content.sourceIntent?.kind === 'stored'
    && environment?.environment.capabilities.deploy === true
    && receipt.content.platform === undefined;
}

/** A receipt's state through the one Work status owner: the glyph and tone every Work row uses. */
export function deploymentWorkStatus(state: ReceiptState): WorkStatusPresentation {
  return resolveWorkStatusTone({ kind: 'deployment', facts: { state, word: deploymentStateLabel(state) } });
}

/** One step's state through the same owner; the step's own label is its word. */
export function deploymentStepWorkStatus(step: DeploymentStepV1): WorkStatusPresentation {
  return resolveWorkStatusTone({ kind: 'deployment', facts: { state: step.state, word: step.label } });
}

export function deploymentStateLabel(state: ReceiptState): string {
  switch (state) {
    case 'queued':
      return t('projects.deployments.stateQueued');
    case 'running':
      return t('projects.deployments.stateRunning');
    case 'running_unverified':
      return t('projects.deployments.stateUnverified');
    case 'succeeded':
      return t('projects.deployments.stateSucceeded');
    case 'failed':
      return t('projects.deployments.stateFailed');
    case 'cancelled':
      return t('projects.deployments.stateCancelled');
    case 'outcome_unknown':
      return t('projects.deployments.stateUnknown');
  }
}

/** An operation by its name, for History's narrowing and anywhere a receipt's kind is said. */
export function deploymentOperationLabel(operation: DeploymentReceiptHeaderV1['operation']): string {
  switch (operation) {
    case 'deploy': return t('projects.deployments.receipt.operationDeploy');
    case 'rollback': return t('projects.deployments.receipt.operationRollback');
    case 'promote': return t('projects.deployments.receipt.operationPromote');
    case 'teardown': return t('projects.deployments.receipt.operationTeardown');
  }
}

/** What was deployed, as a short name: a commit's short id, or a stored definition's revision digest. */
export function deploymentSourceLabel(content: DeploymentContentV1): string | null {
  const source = content.sourceIntent;
  if (!source) return null;
  return deploymentRevisionLabel(source.kind === 'repository'
    ? { kind: 'repository', sha: source.sha }
    : { kind: 'stored', contentRevision: source.contentRevision, composeDigest: source.composeDigest });
}

type ReceiptOperation = DeploymentReceiptHeaderV1['operation'];

/**
 * What failed, from the receipt's recorded operation and phase; a receipt that recorded no cause says only that
 * its operation failed. Every operation in the protocol's vocabulary names itself here, never as "the deploy".
 */
export function deploymentFailureTitle(failure: DeploymentReceiptFailureV1 | null, operation: ReceiptOperation = 'deploy'): string {
  if (failure?.code === 'deployment_activation_not_observed') return t('projects.deployments.failureInterrupted');
  switch (operation) {
    // A rollback brings back a version that served before, so it never reads as "the new version" or "the deploy".
    case 'rollback':
      switch (failure?.phase) {
        case 'activate': return t('projects.deployments.failureRollbackActivate');
        case 'observe': return t('projects.deployments.failureRollbackObserve');
        case 'admission': return t('projects.deployments.failureRollbackAdmission');
        case 'source':
        case 'build':
        case 'restore':
        case 'cleanup': return deployFailureTitle(failure.phase);
        default: return t('projects.deployments.failureRollbackGeneric');
      }
    // A promotion reuses built images, so its activation and health check read like a deploy's; the rest is its own.
    case 'promote':
      switch (failure?.phase) {
        case 'activate':
        case 'observe':
        case 'restore': return deployFailureTitle(failure.phase);
        case 'admission': return t('projects.deployments.receipt.failurePromoteAdmission');
        default: return t('projects.deployments.receipt.failurePromote');
      }
    // Stopping and removing has no new version; it either never started or did not finish.
    case 'teardown':
      return failure?.phase === 'admission'
        ? t('projects.deployments.receipt.failureRemoveAdmission') : t('projects.deployments.receipt.failureRemove');
    case 'deploy':
      return deployFailureTitle(failure?.phase);
  }
}

function deployFailureTitle(phase: DeploymentReceiptFailureV1['phase'] | undefined): string {
  switch (phase) {
    case 'source':
      return t('projects.deployments.failureSource');
    case 'build':
      return t('projects.deployments.failureBuild');
    case 'activate':
      return t('projects.deployments.failureActivate');
    case 'observe':
      return t('projects.deployments.failureObserve');
    case 'restore':
      return t('projects.deployments.failureRestore');
    case 'cleanup':
      return t('projects.deployments.failureCleanup');
    case 'admission':
      return t('projects.deployments.failureAdmission');
    default:
      return t('projects.deployments.failureGeneric');
  }
}

/**
 * What a history row says after its title: a failed attempt's recorded cause in words (the canonical failure
 * title; its code stays on the receipt's Details), else the state word in its tone. Healthy settled says nothing.
 */
export function deploymentHistoryLead(
  receipt: Pick<DeploymentReceiptHeaderV1, 'state' | 'operation'>,
  failure: DeploymentReceiptFailureV1 | null | undefined,
): Readonly<{ tone: 'danger' | 'warning' | null; text: string }> | null {
  if (receipt.state === 'failed' && failure) {
    return { tone: 'danger', text: deploymentFailureTitle(failure, receipt.operation) };
  }
  if (receipt.state === 'outcome_unknown' && failure?.code === 'deployment_activation_not_observed') {
    return deploymentStateNotice(receipt.state, failure);
  }
  return deploymentRailState(receipt.state);
}

/** The receipt page's title: what the receipt's operation did to which version, in the receipt's own state. */
export function deploymentHeadline(
  receipt: DeploymentReceiptHeaderV1,
  content: DeploymentContentV1,
): string {
  return deploymentReceiptTitle(receipt, deploymentSourceLabel(content));
}

/**
 * One receipt's title from its operation, state and version label, for the receipt page and every History row
 * (a History row carries the version as its `source`). Without a version label its state is the title.
 */
export function deploymentReceiptTitle(
  receipt: Pick<DeploymentReceiptHeaderV1, 'state' | 'operation'>,
  sha: string | null,
): string {
  if (sha === null) return deploymentStateLabel(receipt.state);
  switch (receipt.state) {
    case 'queued':
      return t('projects.deployments.headlineQueued', { sha });
    case 'outcome_unknown':
      return t('projects.deployments.headlineUnknown', { sha });
    // The unverified notice carries the state (lab d3 `unverified`); the title says what was done.
    case 'running_unverified':
      return operationHeadline(receipt.operation, 'succeeded', sha);
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return operationHeadline(receipt.operation, receipt.state, sha);
  }
}

/** Each operation's words for each settled or running state; the protocol's operation vocabulary keys it. */
const OPERATION_HEADLINES = {
  deploy: {
    running: 'projects.deployments.headlineDeploying',
    succeeded: 'projects.deployments.headlineDeployed',
    failed: 'projects.deployments.headlineFailed',
    cancelled: 'projects.deployments.headlineCancelled',
  },
  rollback: {
    running: 'projects.deployments.headlineRollingBack',
    succeeded: 'projects.deployments.headlineRolledBack',
    failed: 'projects.deployments.headlineRollbackFailed',
    cancelled: 'projects.deployments.receipt.headlineRollbackCancelled',
  },
  promote: {
    running: 'projects.deployments.receipt.headlinePromoting',
    succeeded: 'projects.deployments.receipt.headlinePromoted',
    failed: 'projects.deployments.receipt.headlinePromoteFailed',
    cancelled: 'projects.deployments.receipt.headlinePromoteCancelled',
  },
  teardown: {
    running: 'projects.deployments.receipt.headlineRemoving',
    succeeded: 'projects.deployments.receipt.headlineRemoved',
    failed: 'projects.deployments.receipt.headlineRemoveFailed',
    cancelled: 'projects.deployments.receipt.headlineRemoveCancelled',
  },
} as const satisfies Record<ReceiptOperation, Record<'running' | 'succeeded' | 'failed' | 'cancelled', string>>;

function operationHeadline(
  operation: ReceiptOperation,
  state: keyof (typeof OPERATION_HEADLINES)[ReceiptOperation],
  sha: string,
): string {
  return t(OPERATION_HEADLINES[operation][state], { sha });
}

/** The one sentence a non-settled or uncertain receipt owes the person; healthy settled receipts say nothing. */
export function deploymentStateNotice(
  state: ReceiptState,
  failure?: DeploymentReceiptFailureV1 | null,
): Readonly<{ tone: 'warning' | 'danger'; text: string }> | null {
  switch (state) {
    case 'outcome_unknown': {
      if (failure?.code === 'deployment_activation_not_observed') return { tone: 'warning', text: deploymentFailureTitle(failure) };
      // A recorded typed cause (T2-RECEIPT) gets the recovery owner's remedy; without one, check the Machine first.
      const cause = failure?.failureCause?.errorCode;
      const recovery = cause ? readDeploymentRefusalRecoveryV1(cause) : null;
      return { tone: 'warning', text: recovery?.remedy ?? t('projects.deployments.unknownBody') };
    }
    case 'running_unverified':
      return {
        tone: 'warning',
        text: t('projects.deployments.unverifiedBody'),
      };
    default:
      return null;
  }
}

/**
 * One Environment's state in every list of Environments (rail, Projects tree, Services, chooser, counts), the
 * Environment page's attention order in small (D11): a failed, unknown or working latest attempt speaks first;
 * then live health, which says Down or Degraded over a settled receipt; "Running, not verified" only while no live
 * health has verified it. One rule, so a list never disagrees with the page.
 */
export function deploymentEnvironmentRowState(item: Readonly<{
  currentDeployment?: Pick<DeploymentReceiptHeaderV1, 'state'> | null;
  healthAggregate?: Pick<NonNullable<DeploymentEnvironmentDetailV1['healthAggregate']>, 'status'> | null;
}>): Readonly<{ tone: 'danger' | 'warning' | null; text: string }> | null {
  const state = item.currentDeployment?.state ?? null;
  if (state === 'failed' || state === 'outcome_unknown' || state === 'queued' || state === 'running') return deploymentRailState(state);
  const health = item.healthAggregate?.status;
  if (health === 'down') return { tone: 'danger', text: t('projects.deployments.healthDown') };
  if (health === 'degraded') return { tone: 'warning', text: t('projects.deployments.healthDegraded') };
  if (health === 'up' && state === 'running_unverified') return null;
  return state ? deploymentRailState(state) : null;
}

/**
 * What the rail says about an Environment's latest attempt (lab d1 rail): trouble only when there is
 * trouble, and work in progress by name. A settled success or cancellation says nothing.
 */
export function deploymentRailState(
  state: ReceiptState,
): Readonly<{ tone: 'danger' | 'warning' | null; text: string }> | null {
  switch (state) {
    case 'failed':
      return { tone: 'danger', text: deploymentStateLabel(state) };
    // Running without a health check needs the person (lab d1 rail `unverified`): amber, like an unknown outcome.
    // A row's end is narrow (a column row keeps its name first): the amber states say their short word there, so
    // neither the word nor the name is cut ("Runnin…", PAGE-ACCEPT-176 R2-D13); the page keeps the full label.
    case 'outcome_unknown':
      return { tone: 'warning', text: t('projects.deployments.stateUnknownShort') };
    case 'running_unverified':
      return { tone: 'warning', text: t('projects.deployments.stateUnverifiedShort') };
    case 'queued':
    case 'running':
      return { tone: null, text: deploymentStateLabel(state) };
    case 'succeeded':
    case 'cancelled':
      return null;
  }
}

export function deploymentMachineHealthLabel(
  result: DeploymentMachineResultV1,
): string {
  switch (result.health) {
    case 'healthy':
      return t('projects.deployments.healthHealthy');
    case 'unhealthy':
      return t('projects.deployments.healthUnhealthy');
    case 'unverified':
      return t('projects.deployments.healthUnverified');
    case 'unknown':
      return t('projects.deployments.healthUnknown');
  }
}

/** How long it ran, from the receipt's own timestamps; null while it has not both started and settled. */
/** When a deploy happened, as every surface says it: when it settled, else when it started, else when it was asked for. */
export function deploymentReceiptAtMs(
  receipt: Pick<DeploymentReceiptHeaderV1, 'requestedAtMs' | 'startedAtMs' | 'settledAtMs'>,
): number {
  return receipt.settledAtMs ?? receipt.startedAtMs ?? receipt.requestedAtMs;
}

export function deploymentDurationMs(
  receipt: DeploymentReceiptHeaderV1,
): number | null {
  return receipt.startedAtMs !== undefined && receipt.settledAtMs !== undefined
    ? Math.max(0, receipt.settledAtMs - receipt.startedAtMs)
    : null;
}

/** What defines what runs: the repository's Compose file path, or Happier's stored definition. */
export function deploymentDefinitionLabel(
  content: DeploymentEnvironmentContentV1,
): string | null {
  return content.definition.kind === 'repository'
    ? content.definition.compose?.path ?? null
    : null;
}

/** Whether this Environment can configure PR previews, and whether its template is enabled. */
export function deploymentPreviewAvailability(
  detail: Pick<DeploymentEnvironmentReadDetailV1, 'environment' | 'content'>,
): 'preview' | 'needsRepository' | 'on' | 'off' {
  if (detail.environment.purpose === 'preview') return 'preview';
  if (detail.content.definition.kind === 'stored') return 'needsRepository';
  return detail.content.previewTemplate?.enabled === true ? 'on' : 'off';
}

/**
 * Whether this Environment can be deployed from here, from its own facts: who may, and whether it has a runtime
 * target. What that target supports its producer decides at the press, and its typed refusal is shown as it says.
 */
export function deploymentDeployAvailability(
  detail: Pick<DeploymentEnvironmentReadDetailV1, 'environment' | 'runtimeTargetLink'>,
):
  | Readonly<{ kind: 'ready'; targetLinkId: string }>
  | Readonly<{ kind: 'denied' | 'noTarget' }> {
  if (!detail.environment.capabilities.deploy) return { kind: 'denied' };
  const link = detail.runtimeTargetLink;
  if (!link) return { kind: 'noTarget' };
  return { kind: 'ready', targetLinkId: link.id };
}

/**
 * The Environment's current health aggregate as one fact (lab `fc-facts`): one word for one server,
 * "2 of 3 servers healthy" when some of several are not, in its tone. Absent means not checked yet, unless the
 * serving receipt ran without a health check: then it says so, in the same words as that receipt's notice.
 */
export function deploymentHealthFact(
  health: Pick<NonNullable<DeploymentEnvironmentDetailV1['healthAggregate']>, 'status' | 'n' | 'down' | 'degraded'> | undefined,
  servingState?: ReceiptState,
): Readonly<{ value: string; tone?: 'danger' | 'attention' }> {
  if (!health || health.status === 'unknown') {
    return { value: servingState === 'running_unverified'
      ? t('projects.deployments.review.noHealthCheck') : t('projects.deployments.healthNotChecked') };
  }
  if (health.status === 'up') return { value: t('projects.deployments.healthUp') };
  const value = health.n > 1
    ? t('projects.deployments.healthServers', { healthy: Math.max(0, health.n - health.down - health.degraded), count: health.n })
    : health.status === 'down' ? t('projects.deployments.healthDown') : t('projects.deployments.healthDegraded');
  return { value, tone: health.status === 'down' ? 'danger' : 'attention' };
}

/**
 * The Environment's one attention slot (DEPLOY-COMPOSE R3), highest precedence first: blocking or offline, then failed,
 * then what needs the person, then information. Notices still waiting on their producer (secret withdrawn → Stop now,
 * missed backup, platform background failure, newer commit) join this list at their rank once their
 * fact lands; nothing else orders deployment notices.
 */
export const DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER = [
  'machineOffline', 'noTarget', 'controllerPaused', 'actionRefused', 'latestFailed', 'approvalWaiting', 'deploying',
  'unhealthy', 'secretWithdrawn', 'runningUnverified', 'catalogUpdate',
] as const;
export type DeploymentEnvironmentAttentionKind = (typeof DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER)[number];
export type DeploymentEnvironmentAttention =
  | Readonly<{ kind: 'latestFailed' | 'deploying'; deploymentId: string }>
  | Readonly<{ kind: Exclude<DeploymentEnvironmentAttentionKind, 'latestFailed' | 'deploying' | 'secretWithdrawn'> }>;

/** The facts the Overview already holds; each comes from its own owner (presence, receipts, health, the press). */
export type DeploymentEnvironmentAttentionFacts = Readonly<{
  /** The single runtime Machine is known offline (not merely unresolved). */
  machineOffline: boolean;
  noTarget: boolean;
  /** T2 controller availability: `paused` means jobs and alerts wait for the controller; `unknown` claims nothing. */
  controller: Readonly<{ state: 'available' | 'paused' | 'unknown' }> | null;
  /** The person's last Deploy press was refused. */
  refused: boolean;
  /** The person's last press is held for review. */
  reviewPending: boolean;
  /** The newest receipt in the Environment's history. */
  latest: Pick<DeploymentReceiptHeaderV1, 'id' | 'state'> | null;
  health: Pick<NonNullable<DeploymentEnvironmentDetailV1['healthAggregate']>, 'status'> | null;
  servingState: ReceiptState | null;
  /** The template's catalog has a newer release (registry update observation). */
  catalogUpdate?: boolean;
}>;

export function deploymentEnvironmentAttention(facts: DeploymentEnvironmentAttentionFacts): DeploymentEnvironmentAttention | null {
  if (facts.machineOffline) return { kind: 'machineOffline' };
  if (facts.noTarget) return { kind: 'noTarget' };
  if (facts.controller?.state === 'paused') return { kind: 'controllerPaused' };
  if (facts.refused) return { kind: 'actionRefused' };
  if (facts.latest?.state === 'failed') return { kind: 'latestFailed', deploymentId: facts.latest.id };
  if (facts.reviewPending) return { kind: 'approvalWaiting' };
  if (facts.latest?.state === 'queued' || facts.latest?.state === 'running') return { kind: 'deploying', deploymentId: facts.latest.id };
  if (facts.health?.status === 'down' || facts.health?.status === 'degraded') return { kind: 'unhealthy' };
  if (facts.servingState === 'running_unverified') return { kind: 'runningUnverified' };
  if (facts.catalogUpdate) return { kind: 'catalogUpdate' };
  return null;
}

/** Whether a notice drawn by its own row (`kind`) still shows beside the slot: only when nothing above it is shown. */
export function deploymentAttentionLeaves(shown: Pick<DeploymentEnvironmentAttention, 'kind'> | null, kind: DeploymentEnvironmentAttentionKind): boolean {
  return shown === null
    || DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER.indexOf(shown.kind) > DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER.indexOf(kind);
}

/**
 * Who a deploy or Action's sentence leads with (lab envOv/fAct): "You", a person's name, "Claude (Ana’s session)",
 * or a workflow's name. Kind and names come from the captured actor through `useDeploymentActorPresentations`;
 * `requestedByAccountId` is an audit/filter fact and never stands in for it (owner ruling 11-15 05:14Z).
 * Null when the historical record captured no actor, or a person's name is still reading.
 */
export function deploymentActorLabel(
  presentation: DeploymentActorPresentation,
  actor: ActionActorV1 | null | undefined,
  viewerAccountId: string | null,
): string | null {
  if (!actor || presentation.actorKind === null) return null;
  if (actor.actorKind === 'person') {
    return actor.accountId === viewerAccountId ? t('projects.deployments.overviewStatus.activityYou') : presentation.displayName;
  }
  if (actor.actorKind === 'workflow') return presentation.displayName ?? t('projects.deployments.overviewStatus.actorAWorkflow');
  const agent = presentation.displayName ?? t('projects.deployments.overviewStatus.actorAnAgent');
  if (!presentation.onBehalfOf) return agent;
  return presentation.onBehalfOf.accountId === viewerAccountId
    ? t('projects.deployments.overviewStatus.actorAgentForYou', { agent })
    : t('projects.deployments.overviewStatus.actorAgentFor', { agent, person: presentation.onBehalfOf.displayName });
}

/** The viewer acted in person (not an agent or workflow acting for them): the "by you" facts read this, never the requester. */
export function deploymentActorIsViewer(actor: ActionActorV1 | null | undefined, viewerAccountId: string | null): boolean {
  return actor?.actorKind === 'person' && actor.accountId === viewerAccountId;
}
