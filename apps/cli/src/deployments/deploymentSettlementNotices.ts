import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createCommittedServiceHealthDelivery } from '@/notifications/activity/committedServiceHealthDelivery';
import { logger } from '@/ui/logger';
import type { OwnServerDeploymentRequest, OwnServerDeploymentTargetHostInput } from './targets/ownServer/ownServerDeploymentTarget';
import { createHealthCheckSourceInstanceIdV1, type HealthAlertIdentityV1,
  type HealthCheckSourceConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { createCliHealthCheckSourceReader } from '@/session/actions/workflowTriggers';
import { projectDeploymentReceiptHistoryEntryV1, type DeploymentBackupRunInputV1 } from '@happier-dev/deployments';
import { projectSavedHealthAlertSelection } from './healthChecks/readSavedHealthCheckSource';
import { deploymentNoticeRollbackChoice, readDeploymentNoticeHistory } from './deploymentNoticeRecovery';
import { readDeploymentNoticeMachineLabels } from './deploymentNoticeLabels';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { buildDeploymentBackupActionInputV1, type DeploymentBackupTargetV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';

/** Capture saved selection at native admission. An unavailable read is never legacy absence. */
export async function readEnvironmentAlertDeliveryForHost(host: Pick<OwnServerDeploymentTargetHostInput,
  'credentials' | 'serverHttpBaseUrl'>, environmentId: string, signal: AbortSignal): Promise<Readonly<
    { kind: 'available'; alerts?: HealthCheckSourceConfigV1['alerts'] } | { kind: 'paused' } | { kind: 'unavailable'; code: string }>> {
  try {
    const source = await createCliHealthCheckSourceReader({ credentials: host.credentials, serverHttpBaseUrl: host.serverHttpBaseUrl, signal })(
      createHealthCheckSourceInstanceIdV1({ kind: 'environment', environmentId }));
    if (!source) return { kind: 'available', alerts: undefined };
    const selection = projectSavedHealthAlertSelection(source);
    return selection.kind === 'active' ? { kind: 'available', alerts: selection.alerts } : selection;
  } catch (error) {
    if (!signal.aborted) logger.warnLocalFile('[deploymentHealth] Alert selection unavailable', {
      failureCause: projectActionFailureCauseV1(error, 'deployment.notice.alert_selection', { allowUnknownErrorCode: false }),
    });
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : 'content_unavailable';
    return { kind: 'unavailable', code };
  }
}

/** Native backup settlement lends its already admitted Environment and exact check.
 * C1 alone decides initial recovery suppression and same-condition deduplication. */
export type BackupNoticeHost = Pick<OwnServerDeploymentTargetHostInput,
  'credentials' | 'serverHttpBaseUrl' | 'serverId' | 'machineId' | 'signal'>;
export type BackupNoticeEnvironment = Readonly<{
  environment: DeploymentEnvironmentDetailV1['environment'];
  content?: Pick<DeploymentEnvironmentDetailV1['content'], 'name'>;
}>;
export function createBackupSettlementNotices(host: BackupNoticeHost) {
  const accountId = readAccountIdFromToken(host.credentials.token);
  const store = createCredentialedAccountArtifactStore(host.credentials);
  const deliver = createCommittedServiceHealthDelivery(host);
  return async (input: Readonly<{
    environment: BackupNoticeEnvironment;
    targetLinkId?: string;
    check: Extract<HealthAlertIdentityV1, { kind: 'backup' }>['check'];
    operationId: string;
    configRevision?: number;
    retryTarget?: DeploymentBackupTargetV1;
    missedSchedule?: Readonly<{ automationId: string; triggerId: string; dueAt: number }>;
    outcome: Parameters<NonNullable<DeploymentBackupRunInputV1['onSettled']>>[0];
    delivery: Awaited<ReturnType<typeof readEnvironmentAlertDeliveryForHost>>;
  }>) => {
    const signal = host.signal ?? new AbortController().signal;
    if (!accountId || signal.aborted || input.outcome === 'cancelled') return;
    const { environment } = input;
    const recovered = input.outcome === 'succeeded';
    try {
      const committed = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.writeNotice({
        accountId, source: { kind: 'host', topic: 'service_health', subject: { kind: 'backup',
          environmentId: environment.environment.id, check: input.check } },
        page: { kind: 'host', page: 'environment', targetLinkId: input.targetLinkId,
          environment: { serverId: host.serverId, projectSourceId: environment.environment.projectSourceId,
            environmentId: environment.environment.id } },
        title: `${environment.content?.name ?? environment.environment.id}: backup ${input.check} ${recovered ? 'recovered'
          : input.missedSchedule ? 'missed'
          : input.outcome === 'outcome_unknown' ? 'outcome unknown' : 'failed'}`,
        type: 'update', healthPhase: recovered ? 'recovered' : 'open', resolved: false,
        ...(input.outcome === 'failed' && input.retryTarget && input.configRevision !== undefined
          ? { recoveryChoices: [{ actionId: DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1,
            label: input.missedSchedule ? 'Run backup now' : 'Run backup again',
            input: buildDeploymentBackupActionInputV1(DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, { ...input.retryTarget,
              expectedRevision: environment.environment.revision, configRevision: input.configRevision }) }] } : {}),
        body: [`Backup ${input.check}. Operation: ${input.operationId}. Outcome: ${input.outcome}.`,
          ...(input.missedSchedule ? [`Missed scheduled backup: ${input.missedSchedule.automationId}/${input.missedSchedule.triggerId}, due at ${input.missedSchedule.dueAt}.`] : []),
          ...(input.configRevision === undefined ? [] : [`Configuration revision: ${input.configRevision}.`]),
          ...(input.delivery.kind === 'unavailable' ? [`Off-app alert settings are unavailable (${input.delivery.code}).`] : [])].join(' '), signal,
      }));
      if (input.delivery.kind === 'available') await deliver({ receipt: committed, signal,
        controllerMachineId: environment.environment.controllerMachineId, alerts: input.delivery.alerts });
    } catch (error) {
      // The native result is already known. A notice failure cannot replay it.
      if (!signal.aborted) logger.warnLocalFile('[deploymentHealth] Backup settlement notice unavailable', {
        failureCause: projectActionFailureCauseV1(error, 'deployment.notice.backup_settlement', { allowUnknownErrorCode: false }),
      });
    }
  };
}

/** The own-server settlement owner lends its admitted receipt, never a second observation. */
export function createDeploymentSettlementNotices(host: OwnServerDeploymentTargetHostInput) {
  const accountId = readAccountIdFromToken(host.credentials.token);
  const store = createCredentialedAccountArtifactStore(host.credentials);
  const deliver = createCommittedServiceHealthDelivery(host);
  return async (request: OwnServerDeploymentRequest, admitted: Readonly<{
    environment: DeploymentEnvironmentDetailV1; receipt: DeploymentReceiptDetailV1;
  }>, settled: typeof admitted | undefined,
    delivery: Awaited<ReturnType<typeof readEnvironmentAlertDeliveryForHost>>) => {
    if (!accountId) return;
    const signal = host.signal ?? new AbortController().signal;
    const context = { signal };
    const admit = ({ environment, receipt }: typeof admitted) => {
      const owner = environment.environment;
      const link = environment.targetLinks.find(value => value.targetLink.id === request.input.targetLinkId)?.targetLink;
      if (signal.aborted || owner.id !== admitted.environment.environment.id || owner.serverId !== host.serverId
        || owner.revision !== admitted.environment.environment.revision || owner.projectSourceId !== admitted.environment.environment.projectSourceId
        || !owner.capabilities.read
        || owner.controllerMachineId !== host.machineId || !link || owner.runtimeTargetLinkId !== link.id
        || link.source.kind !== 'host' || link.targetKind !== 'ownServer'
        || receipt.deployment.id !== admitted.receipt.deployment.id || receipt.deployment.environmentId !== owner.id
        || receipt.deployment.targetLinkId !== link.id || receipt.deployment.actionOperationId !== admitted.receipt.deployment.actionOperationId
        || !['failed', 'outcome_unknown', 'succeeded'].includes(receipt.deployment.state)) return null;
      // Success is authoritative for this condition only when the settlement
      // owner's uniform pointer selects this exact receipt.
      if (receipt.deployment.state === 'succeeded' && link.activeDeploymentId !== receipt.deployment.id) return null;
      return { environment, receipt, link };
    };
    const readCurrent = async () => {
      if (signal.aborted) return null;
      const [environment, receipt] = await Promise.all([
        host.readEnvironment({ environmentId: request.input.environmentId, context }),
        host.readReceipt({ environmentId: request.input.environmentId, deploymentId: admitted.receipt.deployment.id, context }),
      ]);
      return admit({ environment, receipt });
    };
    try {
      // Retention and notice preparation consume the same settled observation.
      // A failed/missing retention read still uses the notice's own opener.
      const current = settled ? admit(settled) : await readCurrent();
      if (!current) return;
      const { environment, receipt, link } = current;
      const recovered = receipt.deployment.state === 'succeeded';
      const [history, labels] = await Promise.all([
        receipt.deployment.state === 'failed' ? readDeploymentNoticeHistory(host.readBuildHistory?.({
          environmentId: environment.environment.id, targetLinkId: link.id, environment, context })) : [],
        readDeploymentNoticeMachineLabels({ credentials: host.credentials, token: host.credentials.token,
          serverHttpBaseUrl: host.serverHttpBaseUrl, machineIds: receipt.content.machineResults.map(row => row.machineId), signal }),
      ]);
      const rollbackChoice = receipt.deployment.state === 'failed' ? deploymentNoticeRollbackChoice(environment, receipt, history) : null;
      const deploymentLabel = projectDeploymentReceiptHistoryEntryV1(receipt).historyTitle;
      const healthyIncumbent = link.activeDeploymentId !== undefined && link.members.length > 0 && link.members.every(member =>
        receipt.content.machineResults.some(row => row.machineId === member.machineId && row.installationId === member.installationId
          && row.currentDeploymentId === link.activeDeploymentId && row.health === 'healthy'));
      // The current Environment read admits Source access; its ownership does
      // not select the private notice recipient, which remains this Account.
      const committed = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.writeNotice({
        accountId, source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
          environmentId: environment.environment.id, targetLinkId: link.id, condition: 'deployment_failed' } },
        page: { kind: 'host', page: 'environment', targetLinkId: link.id, deploymentId: receipt.deployment.id, environment: { serverId: host.serverId,
          projectSourceId: environment.environment.projectSourceId, environmentId: environment.environment.id } },
        ...(rollbackChoice ? { recoveryChoices: [rollbackChoice] } : {}),
        title: `${environment.content.name}: ${recovered ? 'deployment recovered' : receipt.deployment.state === 'outcome_unknown'
          ? 'deployment outcome unknown' : 'deployment failed'}`,
        type: !recovered && environment.environment.protection === 'production'
          && (receipt.deployment.state === 'outcome_unknown' || !healthyIncumbent) ? 'blocked' : 'update',
        healthPhase: recovered ? 'recovered' : 'open', resolved: false,
        body: [`${deploymentLabel ? `Deployment: ${deploymentLabel}` : 'Deployment'}. Outcome: ${receipt.deployment.state}.`,
          ...(delivery.kind === 'unavailable' ? [`Off-app alert settings are unavailable (${delivery.code}).`] : []),
          ...[...receipt.content.machineResults].sort((left, right) => left.machineId.localeCompare(right.machineId)).map(row =>
            `${labels.get(row.machineId) ?? 'Machine name unavailable'}: ${row.health}${row.restoration ? `; restoration ${row.restoration}` : ''}.`),
        ].join(' '), signal,
      }));
      if (delivery.kind === 'available') await deliver({ receipt: committed, signal,
        controllerMachineId: environment.environment.controllerMachineId, alerts: delivery.alerts });
    } catch (error) {
      // The receipt has already settled. Alert availability cannot change its
      // result or authorize replay; another actual settlement is the next wake.
      if (!signal.aborted) logger.warnLocalFile('[deploymentHealth] Settlement notice unavailable', {
        failureCause: projectActionFailureCauseV1(error, 'deployment.notice.settlement', { allowUnknownErrorCode: false }),
      });
    }
  };
}
