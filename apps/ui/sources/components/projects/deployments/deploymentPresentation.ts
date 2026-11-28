import { ActionFailureCauseV1Schema, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_TEARDOWN_STEPS_V1, type DeploymentTeardownContentV1 } from '@happier-dev/protocol/deployments/deploymentTeardownContentV1';
import { isNativeDeploymentPromotionSourceV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentEnvironmentContentV1, DeploymentMachineResultV1, DeploymentReceiptFailureV1, DeploymentReceiptDetailV1, DeploymentStepV1 } from '@happier-dev/deployments/contracts/v1';
import { deploymentHealthSavedCheckCauseV1, isDeploymentServiceRunningWithoutCheckV1, type DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { t } from '@/text';
import { isRecord } from '@happier-dev/protocol/common/records';
import type { DeploymentActorPresentation } from './useDeploymentActorPresentations';
import { readDeploymentRefusal } from './deploymentActionOutcome';
import { readDeploymentFailureRecoveryV1, readDeploymentRefusalRecoveryV1, type DeploymentFailureRecoveryPresentationV1, type DeploymentRefusalRequestV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION, type PublishTargetRecommendationInput } from '@happier-dev/protocol/deployments/resolvePublishTargetRecommendation';
import { deploymentRevisionLabelV1 as deploymentRevisionLabel } from '@happier-dev/deployments';
import { deploymentReceiptTitleV1, deploymentSettledReceiptStateV1 as deploymentSettledReceiptState } from '@happier-dev/deployment-protocol/v1';
export { deploymentRevisionLabel, deploymentSettledReceiptState };

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
export function deploymentActionRefusalRemedy(code: string, definition?: PublishTargetRecommendationInput['definition'],
  platformCount = 1): string {
  if (code === 'deployment_conflict' || code === 'host_retired' || code === 'action_account_scope_changed')
    return t('projects.deployments.copy.refresh');
  if (code === DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION) {
    if (definition && 'from' in definition) {
      if (definition.from === 'catalogApp') return t('projects.deployments.recommendation.catalogRequiresRepository');
      if (definition.from === 'folder') return t('newApp.deploy.cantRunStored');
    }
    return t(platformCount > 1 ? 'projects.deployments.recommendation.requiresRepositoryMany'
      : 'projects.deployments.recommendation.requiresRepository');
  }
  switch (readDeploymentRefusal(code).reason) {
    case 'permission': return t('projects.deployments.copy.permission');
    case 'machine': return t('projects.deployments.copy.machine');
    case 'repository': return t('projects.deployments.copy.repository');
    case 'unsupported': return t('projects.deployments.copy.unsupported');
    case 'other': return t('projects.deployments.copy.retry');
  }
}

/** The provider reports its missing token permission separately from Home access. */
export function readDeploymentConnectionPermissionRemedy(code: string | undefined, details: unknown): string | null {
  if (code !== 'cloudflare_builds_configuration_edit_required') return null;
  const permission = isRecord(details) ? details.requiredPermission : undefined;
  return t('projects.deployments.platformLink.connectionRequiresPermission', {
    permission: typeof permission === 'string' && permission.trim()
      ? permission : 'Workers Builds Configuration (Edit)',
  });
}

type ReceiptState = DeploymentReceiptHeaderV1['state'];

/** Both entry points present a release its Promote owner can review. */
export function readDeploymentPromotionTarget(
  receipt: Pick<DeploymentReceiptDetailV1, 'deployment' | 'content'>,
  environment: DeploymentEnvironmentReadDetailV1 | null,
  providerPromote: Readonly<{ consequence: string | null }> | undefined | null,
) {
  if (environment?.environment.capabilities.deploy !== true) return null;
  const { content, deployment } = receipt;
  if (content.platform) {
    return providerPromote && deployment.state === 'succeeded' && content.platform.observation.providerDeploymentId
      ? { kind: 'platform' as const, consequence: providerPromote.consequence } : null;
  }
  return isNativeDeploymentPromotionSourceV1({ state: deployment.state, hasImages: content.images.length > 0 })
    ? { kind: 'ownServer' as const } : null;
}

/** A receipt's state through the one Work status owner: the glyph and tone every Work row uses. */
export function deploymentWorkStatus(receiptState: ReceiptState): WorkStatusPresentation {
  const state = deploymentSettledReceiptState(receiptState);
  return resolveWorkStatusTone({ kind: 'deployment', facts: { state, word: deploymentStateLabel(state) } });
}

/** One step's state through the same owner; the step's own label is its word. */
export function deploymentStepWorkStatus(step: DeploymentStepV1): WorkStatusPresentation {
  return resolveWorkStatusTone({ kind: 'deployment', facts: { state: step.state, word: step.label } });
}

const BACKUP_CREDENTIAL_LABEL: Readonly<Record<string, 'credentialAccessKeyId' | 'credentialSecretAccessKey'
  | 'credentialRepositoryPassword' | 'credentialSessionToken' | 'credentialSshPrivateKey'>> = {
  accessKeyId: 'credentialAccessKeyId', secretAccessKey: 'credentialSecretAccessKey',
  repositoryPassword: 'credentialRepositoryPassword', sessionToken: 'credentialSessionToken', sshPrivateKey: 'credentialSshPrivateKey',
};

/** A backup credential role by its name ("Repository password"), never its key, wherever a role is said. */
export function deploymentBackupCredentialLabel(role: string): string {
  return t(`projects.deployments.settingsSections.${BACKUP_CREDENTIAL_LABEL[role] ?? 'credentialRepositoryPassword'}`);
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
    case 'skipped':
      return t('projects.deployments.stateSkipped');
    case 'outcome_unknown':
      return t('projects.deployments.stateUnknown');
  }
}

/** A Machine's reachability verdict for `useServerScopedMachine`'s selector: null while it is not known here. */
export const readDeploymentMachineOnline = (machine: Machine | null): boolean | null =>
  machine ? isMachineOnline(machine) : null;

/** An operation by its name, for History's narrowing and anywhere a receipt's kind is said. */
export function deploymentOperationLabel(operation: DeploymentReceiptHeaderV1['operation']): string {
  switch (operation) {
    case 'deploy': return t('projects.deployments.receipt.operationDeploy');
    case 'rollback': return t('projects.deployments.receipt.operationRollback');
    case 'promote': return t('projects.deployments.receipt.operationPromote');
    case 'teardown': return t('projects.deployments.receipt.operationTeardown');
  }
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
 * What a history row says after its title: the recorded cause when available, or the failed step's title.
 * Healthy settled says nothing.
 */
export function deploymentHistoryLead(
  receipt: Pick<DeploymentReceiptHeaderV1, 'state' | 'operation'>,
  failure: DeploymentReceiptFailureV1 | null | undefined,
): Readonly<{ tone: 'danger' | 'warning' | null; text: string }> | null {
  if (receipt.state === 'failed' && failure) {
    const carrierUnavailable = failure.code === 'machine_carrier_unavailable'
      || failure.failureCause?.errorCode === 'machine_carrier_unavailable';
    const remedy = failure.nativeActivation || carrierUnavailable
      ? readDeploymentRefusalRecovery(failure.code, failure)?.remedy : null;
    return { tone: 'danger', text: remedy ?? deploymentFailureTitle(failure, receipt.operation) };
  }
  if (receipt.state === 'outcome_unknown' && failure?.code === 'deployment_activation_not_observed') {
    return deploymentStateNotice(receipt.state, failure);
  }
  return deploymentRailState(deploymentSettledReceiptState(receipt.state));
}

const receiptTitleCopy = {
  headline: t,
  state: deploymentStateLabel,
};

/** A native volume by the name its Compose file gives it, never Compose's `happier-<id>_` project prefix (R15-D9). */
export function deploymentVolumeDisplayName(name: string): string {
  return name.replace(/^happier-[0-9a-f]+_/, '');
}

/**
 * What a removal did to each volume, by name: the signed proofs say what is gone or kept; a volume no proof mentions
 * reads by the disposition the person chose.
 */
export function deploymentRemovalVolumes(teardown: DeploymentTeardownContentV1 | undefined): Readonly<{
  deleted: readonly string[]; kept: readonly string[];
}> {
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const resource of teardown?.resources ?? []) {
    if (resource.kind !== 'data') continue;
    const proved = teardown!.proofs.flatMap(proof => proof.resources)
      .filter(entry => entry.resourceId === resource.id).map(entry => entry.disposition);
    const gone = proved.includes('absent') || (proved.length === 0 && resource.disposition === 'remove');
    (gone ? deleted : kept).push(deploymentVolumeDisplayName(resource.id));
  }
  return { deleted, kept };
}

/**
 * A removal's settled steps, read from its own signed proofs in their removal order ("Stopped and removed its
 * services", "Checked what was removed and what was kept"): a native removal records no deploy steps of its own.
 * Several Machines name theirs on each step. Empty when the removal carries no proofs.
 */
export function deploymentRemovalSteps(
  teardown: DeploymentTeardownContentV1 | undefined,
  machineName: (machineId: string) => string,
): readonly DeploymentStepV1[] {
  if (!teardown || teardown.proofs.length === 0) return [];
  const several = new Set(teardown.proofs.map(proof => proof.machineId)).size > 1;
  return teardown.machines.flatMap(member => DEPLOYMENT_TEARDOWN_STEPS_V1.flatMap(step => {
    const proof = teardown.proofs.find(candidate => candidate.machineId === member.machineId && candidate.step === step);
    if (!proof) return [];
    const label = t(`projects.deployments.removalSteps.${step}`);
    return [{ id: `teardown.${member.machineId}.${step}`, state: proof.state,
      label: several ? [label, machineName(member.machineId)].join(' · ') : label }];
  }));
}

/**
 * An Environment by its Project and its own name ("Team Wiki Production"), so two Productions read apart. The
 * Environment alone when the Project is unknown or already says it; null until either name is known.
 */
export function deploymentEnvironmentSubject(
  projectName: string | null | undefined,
  environmentName: string | null | undefined,
): string | null {
  const environment = environmentName?.trim() || null;
  const project = projectName?.trim() || null;
  if (!environment) return null;
  if (!project || project.localeCompare(environment, undefined, { sensitivity: 'accent' }) === 0) return environment;
  return t('projects.deployments.environmentInProject', { project, environment });
}

/**
 * A settled removal is titled by what it removed ("Team Wiki Production removed"), never by the commit it last ran.
 * `subject` is `deploymentEnvironmentSubject`'s reading; the page header, its tab and the History row all read here.
 */
export function deploymentReceiptPageTitle(
  receipt: Pick<DeploymentReceiptHeaderV1, 'state' | 'operation'>,
  revisionLabel: string | null,
  subject: string | null | undefined,
): string {
  return deploymentRemovalTitle(receipt, subject) ?? deploymentReceiptTitle(receipt, revisionLabel);
}

/** A settled removal's title by what it removed, or null for any other receipt or while nothing names it yet. */
export function deploymentRemovalTitle(
  receipt: Pick<DeploymentReceiptHeaderV1, 'state' | 'operation'>,
  subject: string | null | undefined,
): string | null {
  return receipt.operation === 'teardown' && receipt.state === 'succeeded' && subject
    ? t('projects.deployments.removedOutcomeTitle', { name: subject }) : null;
}

export function deploymentReceiptTitle(
  receipt: Pick<DeploymentReceiptHeaderV1, 'state' | 'operation'>,
  revisionLabel: string | null,
): string {
  return deploymentReceiptTitleV1(receipt, revisionLabel, receiptTitleCopy);
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
 * then live health, which says Down or Degraded over a settled receipt. A version with no health check is quiet
 * here: the Overview's Health says it once, with its action (R15-D1). One rule, so a list never disagrees with the page.
 */
export function deploymentEnvironmentRowState(item: EnvironmentHealthPresentationInput & Readonly<{
  currentDeployment?: Pick<DeploymentReceiptHeaderV1, 'state'> | null;
}>): Readonly<{ tone: 'danger' | 'warning' | null; text: string; causeTitle?: string }> | null {
  const state = item.currentDeployment?.state ?? null;
  if (state === 'failed' || state === 'outcome_unknown' || state === 'queued' || state === 'running') return deploymentRailState(state);
  const { fact, causeTitle } = deploymentEnvironmentHealthPresentation(item);
  if (fact.tone) return { tone: fact.tone === 'danger' ? 'danger' : 'warning', text: fact.value,
    ...(causeTitle ? { causeTitle } : {}) };
  return state ? deploymentRailState(state) : null;
}

/** A list's quiet State word for a settled deploy: a version running without a health check was still deployed. */
export function deploymentSettledStateLabel(state: ReceiptState): string {
  return deploymentStateLabel(deploymentSettledReceiptState(state));
}

type HealthAggregate = NonNullable<DeploymentEnvironmentDetailV1['healthAggregate']>;
type HealthEvidence = Pick<HealthAggregate, 'status'> & Partial<Pick<HealthAggregate, 'members'>>;

/** Only current native evidence can confirm that a running service lacks a check. */
export function deploymentEnvironmentHealthKind(
  health: HealthEvidence | null | undefined,
): HealthAggregate['status'] | 'unchecked' {
  if (!health) return 'unknown';
  if (health.status !== 'unknown') return health.status;
  const unresolved = health.members?.flatMap(member => member.evidence.filter(evidence => evidence.status === 'unknown'));
  return unresolved?.length && unresolved.every(evidence => evidence.role === 'runtime' && evidence.source === 'native'
    && isDeploymentServiceRunningWithoutCheckV1(evidence.status, evidence.reason)) ? 'unchecked' : 'unknown';
}

export function deploymentEnvironmentVerificationLabel(
  runtime: Pick<NonNullable<DeploymentEnvironmentReadDetailV1['runtimeTargetLink']>, 'source' | 'targetKind'> | null | undefined,
): string {
  if (runtime?.source.kind === 'host' && runtime.targetKind === 'ownServer') {
    return t('projects.deployments.overviewStatus.addComposeHealthCheck');
  }
  return deploymentStateLabel('running_unverified');
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
    // A row's end is narrow (a column row keeps its name first): an unknown outcome says its short word there, so
    // neither the word nor the name is cut ("Runnin…", PAGE-ACCEPT-176 R2-D13); the page keeps the full label.
    case 'outcome_unknown':
      return { tone: 'warning', text: t('projects.deployments.stateUnknownShort') };
    case 'queued':
    case 'running':
      return { tone: null, text: deploymentStateLabel(state) };
    // Health is the Environment's one fact (its Overview); a version without a health check is no trouble in a row.
    case 'running_unverified':
    case 'succeeded':
    case 'cancelled':
    case 'skipped':
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
  return content.definition.kind === 'stored' ? null : content.definition.compose?.path ?? null;
}

/** Whether this Environment can configure PR previews, and whether its template is enabled. */
export function deploymentPreviewAvailability(
  detail: Pick<DeploymentEnvironmentReadDetailV1, 'environment' | 'content'>,
): 'preview' | 'needsRepository' | 'on' | 'off' {
  if (detail.environment.purpose === 'preview') return 'preview';
  if (detail.content.definition.kind !== 'repository') return 'needsRepository';
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
 * One word for the Environment's health. The separate attention presentation names the leading cause.
 */
export function deploymentHealthFact(
  health: HealthEvidence | null | undefined,
  latestState?: ReceiptState,
): Readonly<{ value: string; tone?: 'danger' | 'attention' }> {
  const kind = deploymentEnvironmentHealthKind(health);
  if (kind === 'unchecked') return { value: latestState === 'queued' || latestState === 'running' ? '—'
    : t('projects.deployments.review.noHealthCheck') };
  if (!health || kind === 'unknown') return { value: '—' };
  if (kind === 'up') return { value: t('projects.deployments.healthUp') };
  return kind === 'down'
    ? { value: t('projects.deployments.healthDown'), tone: 'danger' }
    : { value: t('projects.deployments.healthDegraded'), tone: 'attention' };
}

type EnvironmentHealthPresentationInput = Pick<DeploymentEnvironmentReadDetailV1, 'healthAggregate'> & Readonly<{
  healthFeed?: Pick<NonNullable<DeploymentEnvironmentReadDetailV1['healthFeed']>, 'leadingCause'>;
}>;

export function deploymentEnvironmentHealthPresentation(
  detail: EnvironmentHealthPresentationInput,
  latestState?: ReceiptState,
) {
  const fact = deploymentHealthFact(detail.healthAggregate, latestState);
  const cause = detail.healthFeed?.leadingCause === undefined
    ? deploymentHealthSavedCheckCauseV1(detail.healthAggregate) : detail.healthFeed.leadingCause;
  const causeTitle = cause?.kind === 'service'
    ? t(cause.state === 'stopped' ? 'projects.deployments.overviewStatus.serviceStopped'
      : 'projects.deployments.overviewStatus.serviceUnhealthy', { name: cause.name })
    : cause?.kind === 'savedCheck'
      ? t('projects.deployments.checksFailing', { names: cause.checks.map(check => check.name).join(', ') })
      : null;
  return { fact, cause, causeTitle };
}

/**
 * The Environment's one attention slot (DEPLOY-COMPOSE R3), highest precedence first: blocking or offline, then failed,
 * then what needs the person, then information. Notices still waiting on their producer (secret withdrawn → Stop now,
 * missed backup, platform background failure, newer commit) join this list at their rank once their
 * fact lands; nothing else orders deployment notices.
 */
export const DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER = [
  'machineOffline', 'machineReinstalled', 'noTarget', 'controllerPaused', 'actionRefused', 'latestFailed', 'latestUnknown', 'approvalWaiting', 'deploying',
  'unhealthy', 'secretWithdrawn', 'runningUnverified', 'catalogUpdate',
] as const;
export type DeploymentEnvironmentAttentionKind = (typeof DEPLOYMENT_ENVIRONMENT_ATTENTION_ORDER)[number];
export type DeploymentEnvironmentAttention =
  | Readonly<{ kind: 'latestFailed' | 'latestUnknown' | 'deploying'; deploymentId: string }>
  | Readonly<{ kind: Exclude<DeploymentEnvironmentAttentionKind, 'latestFailed' | 'latestUnknown' | 'deploying' | 'secretWithdrawn'> }>;

/** The facts the Overview already holds; each comes from its own owner (presence, receipts, health, the press). */
export type DeploymentEnvironmentAttentionFacts = Readonly<{
  /** The single runtime Machine is known offline (not merely unresolved). */
  machineOffline: boolean;
  /** The Environment read's `runtimeReinstall`: a runtime Machine was reinstalled since this Environment deployed there. */
  machineReinstalled?: boolean;
  noTarget: boolean;
  /** T2 controller availability: `paused` means jobs and alerts wait for the controller; `unknown` claims nothing. */
  controller: Readonly<{ state: 'available' | 'paused' | 'unknown' }> | null;
  /** The person's last Deploy press was refused. */
  refused: boolean;
  /** The receipt that refused press ran and left, when it got that far: the latest failure then speaks for it. */
  refusedDeploymentId?: string | null;
  /** The person's last press is held for review. */
  reviewPending: boolean;
  /** The newest receipt in the Environment's history. */
  latest: Pick<DeploymentReceiptHeaderV1, 'id' | 'state'> | null;
  health: HealthEvidence | null;
  /** The template's catalog has a newer release (registry update observation). */
  catalogUpdate?: boolean;
}>;

export function deploymentEnvironmentAttention(facts: DeploymentEnvironmentAttentionFacts): DeploymentEnvironmentAttention | null {
  if (facts.machineOffline) return { kind: 'machineOffline' };
  // Every deploy there refuses until it is reinstalled, so the reinstall is the one thing said (the refusal is not).
  if (facts.machineReinstalled) return { kind: 'machineReinstalled' };
  if (facts.noTarget) return { kind: 'noTarget' };
  if (facts.controller?.state === 'paused') return { kind: 'controllerPaused' };
  // A press that ran and failed is the latest failure itself: one banner, the same before and after a reload (R15-D6).
  const refusalIsLatestFailure = facts.latest?.state === 'failed' && facts.refusedDeploymentId === facts.latest.id;
  if (facts.refused && !refusalIsLatestFailure) return { kind: 'actionRefused' };
  if (facts.latest?.state === 'failed') return { kind: 'latestFailed', deploymentId: facts.latest.id };
  // A deploy Happier could not confirm is said here once, as the rail says "Unconfirmed" (R18-D2).
  if (facts.latest?.state === 'outcome_unknown') return { kind: 'latestUnknown', deploymentId: facts.latest.id };
  if (facts.reviewPending) return { kind: 'approvalWaiting' };
  if (facts.latest?.state === 'queued' || facts.latest?.state === 'running') return { kind: 'deploying', deploymentId: facts.latest.id };
  const health = deploymentEnvironmentHealthKind(facts.health);
  if (health === 'down' || health === 'degraded') return { kind: 'unhealthy' };
  if (health === 'unchecked') return { kind: 'runningUnverified' };
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

/**
 * A refusal's recovery from its one owner, with the Machine it points at named as the person sees it everywhere else
 * ("NLDW3-5-36-33 · a729"), never by its raw id (QA-SWEEP-172 #201). The protocol owner names only the id it carries.
 */
export function readDeploymentRefusalRecovery(
  errorCode: string, details?: unknown, request?: DeploymentRefusalRequestV1, causeCode?: string | null,
  context?: { failureCause?: ActionFailureCauseV1; machine?: string | null },
) {
  const recovery = readDeploymentRefusalRecoveryV1(context?.failureCause?.errorCode === 'deployment_image_rate_limited'
    ? context.failureCause.errorCode : errorCode, details, request);
  if (recovery?.nextAction.destination === 'registryCredentials') {
    const cause = context?.failureCause ?? ActionFailureCauseV1Schema.safeParse(
      details && typeof details === 'object' && 'failureCause' in details ? details.failureCause : undefined,
    ).data;
    const registry = cause && 'nativeErrorReason' in cause && cause.nativeErrorReason === 'docker_hub'
      ? 'Docker Hub' : t('projects.deployments.settingsSections.registryGenericName');
    return { ...recovery, remedy: t('projects.deployments.settingsSections.registryRateLimited', {
      registry, machine: context?.machine ?? t('machine.thisMachineInSentence'),
    }), nextAction: { ...recovery.nextAction, label: t('projects.deployments.settingsSections.registryTitle') } };
  }
  if (!recovery) return null;
  const { destination, machineId } = recovery.nextAction;
  const reason = destination === 'machineAdminAccess' && machineId && causeCode
    ? describeDeploymentDomainAdminAccessRefusal(causeCode, recoveryMachineLabel(machineId)) : null;
  return reason ? { ...recovery, remedy: reason } : nameRecoveryMachine(recovery);
}

/** The native refusal records why the Machine could not perform the change. The Machine owns its setup instructions. */
function describeDeploymentDomainAdminAccessRefusal(causeCode: string | null | undefined, machineLabel: string | null): string | null {
  const machine = machineLabel ?? t('machine.thisMachineInSentence');
  if (causeCode === 'mode_none') return t('projects.deployments.review.domainSetup.administratorOff', { machine });
  if (causeCode === 'not_preauthorized') return t('projects.deployments.review.domainSetup.passwordlessUnavailable', { machine });
  return null;
}

/** The same for a failure's recovery (every refused code has one); every deployment refusal surface reads one of these two. */
export function readDeploymentFailureRecovery(...args: Parameters<typeof readDeploymentFailureRecoveryV1>) {
  return nameRecoveryMachine(readDeploymentFailureRecoveryV1(...args));
}

function nameRecoveryMachine<T extends DeploymentFailureRecoveryPresentationV1>(recovery: T): T {
  const machineId = recovery.nextAction.kind === 'navigate' ? recovery.nextAction.machineId : undefined;
  if (!machineId || !recovery.remedy.includes(machineId)) return recovery;
  const name = recoveryMachineLabel(machineId);
  return name ? { ...recovery, remedy: recovery.remedy.split(machineId).join(name) } : recovery;
}

function recoveryMachineLabel(machineId: string): string | null {
  const state = getStorage().getState();
  // The refusal belongs to the Account in view; its Machine resolves in that Home's inventory.
  return getSettledMachineDisplayName(resolveServerScopedMachine(state, state.profileScope?.serverId ?? null, machineId));
}

/**
 * "Kept for rollback" in words: the count kept, "None yet" while a policy that keeps releases has none to keep, and
 * "Off" only when the policy keeps none (R14-D9). An unknown policy says "None yet" rather than claim it is off.
 */
export function keptForRollbackValue(kept: number, policy: number | undefined): string {
  if (kept > 0) return t('projects.deployments.keptCount', { count: kept });
  return policy === 0 ? t('projects.deployments.keptNone') : t('projects.deployments.keptNoneYet');
}
