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
import { t } from '@/text';
import { readDeploymentRefusal } from './deploymentActionOutcome';
import { deploymentRevisionLabelV1 as deploymentRevisionLabel } from '@happier-dev/deployments';
export { deploymentRevisionLabel };

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

/** What was deployed, as a short name: a commit's short id, or a stored definition's revision digest. */
export function deploymentSourceLabel(content: DeploymentContentV1): string | null {
  const source = content.sourceIntent;
  if (!source) return null;
  return deploymentRevisionLabel(source.kind === 'repository'
    ? { kind: 'repository', sha: source.sha }
    : { kind: 'stored', contentRevision: source.contentRevision, composeDigest: source.composeDigest });
}

/** What failed, from the receipt's recorded phase; a receipt that recorded no cause says only that it failed. */
export function deploymentFailureTitle(failure: DeploymentReceiptFailureV1 | null, rollback = false): string {
  if (failure?.code === 'deployment_activation_not_observed') return t('projects.deployments.failureInterrupted');
  // A rollback brings back a version that served before, so it never reads as "the new version" or "the deploy".
  if (rollback) {
    switch (failure?.phase) {
      case 'activate':
        return t('projects.deployments.failureRollbackActivate');
      case 'observe':
        return t('projects.deployments.failureRollbackObserve');
      case 'admission':
        return t('projects.deployments.failureRollbackAdmission');
      case 'source':
      case 'build':
      case 'restore':
      case 'cleanup':
        break;
      default:
        return t('projects.deployments.failureRollbackGeneric');
    }
  }
  switch (failure?.phase) {
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
    return { tone: 'danger', text: deploymentFailureTitle(failure, receipt.operation === 'rollback') };
  }
  if (receipt.state === 'outcome_unknown' && failure?.code === 'deployment_activation_not_observed') {
    return deploymentStateNotice(receipt.state, failure);
  }
  return deploymentRailState(receipt.state);
}

/** The receipt page's title: what happened to which version, in the receipt's own state. */
export function deploymentHeadline(
  receipt: DeploymentReceiptHeaderV1,
  content: DeploymentContentV1,
): string {
  const sha = deploymentSourceLabel(content);
  if (sha === null) return deploymentStateLabel(receipt.state);
  const rollback = receipt.operation === 'rollback';
  switch (receipt.state) {
    case 'queued':
      return t('projects.deployments.headlineQueued', { sha });
    case 'running':
      return rollback
        ? t('projects.deployments.headlineRollingBack', { sha })
        : t('projects.deployments.headlineDeploying', { sha });
    // The unverified notice carries the state (lab d3 `unverified`); the title says what was done.
    case 'running_unverified':
    case 'succeeded':
      return rollback
        ? t('projects.deployments.headlineRolledBack', { sha })
        : t('projects.deployments.headlineDeployed', { sha });
    case 'failed':
      return rollback
        ? t('projects.deployments.headlineRollbackFailed', { sha })
        : t('projects.deployments.headlineFailed', { sha });
    case 'cancelled':
      return t('projects.deployments.headlineCancelled', { sha });
    case 'outcome_unknown':
      return t('projects.deployments.headlineUnknown', { sha });
  }
}

/** The one sentence a non-settled or uncertain receipt owes the person; healthy settled receipts say nothing. */
export function deploymentStateNotice(
  state: ReceiptState,
  failure?: DeploymentReceiptFailureV1 | null,
): Readonly<{ tone: 'warning' | 'danger'; text: string }> | null {
  switch (state) {
    case 'outcome_unknown':
      return { tone: 'warning', text: failure?.code === 'deployment_activation_not_observed'
        ? deploymentFailureTitle(failure) : t('projects.deployments.unknownBody') };
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
    case 'outcome_unknown':
    case 'running_unverified':
      return { tone: 'warning', text: deploymentStateLabel(state) };
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
