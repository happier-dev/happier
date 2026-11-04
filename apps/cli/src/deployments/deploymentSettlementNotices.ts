import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createCommittedServiceHealthDelivery } from '@/notifications/activity/committedServiceHealthDelivery';
import { logger } from '@/ui/logger';
import type { OwnServerDeploymentRequest, OwnServerDeploymentTargetHostInput } from './targets/ownServer/ownServerDeploymentTarget';

/** The own-server settlement owner lends its admitted receipt, never a second observation. */
export function createDeploymentSettlementNotices(host: OwnServerDeploymentTargetHostInput) {
  const accountId = readAccountIdFromToken(host.credentials.token);
  const store = createCredentialedAccountArtifactStore(host.credentials);
  const deliver = createCommittedServiceHealthDelivery(host);
  return async (request: OwnServerDeploymentRequest, admitted: Readonly<{
    environment: DeploymentEnvironmentDetailV1; receipt: DeploymentReceiptDetailV1;
  }>, settled?: typeof admitted) => {
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
      const healthyIncumbent = link.activeDeploymentId !== undefined && link.members.length > 0 && link.members.every(member =>
        receipt.content.machineResults.some(row => row.machineId === member.machineId && row.installationId === member.installationId
          && row.currentDeploymentId === link.activeDeploymentId && row.health === 'healthy'));
      // The current Environment read admits Source access; its ownership does
      // not select the private notice recipient, which remains this Account.
      const committed = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.writeNotice({
        accountId, source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
          environmentId: environment.environment.id, targetLinkId: link.id, condition: 'deployment_failed' } },
        page: { kind: 'host', page: 'environment', targetLinkId: link.id, environment: { serverId: host.serverId,
          projectSourceId: environment.environment.projectSourceId, environmentId: environment.environment.id } },
        title: `${environment.content.name}: ${recovered ? 'deployment recovered' : receipt.deployment.state === 'outcome_unknown'
          ? 'deployment outcome unknown' : 'deployment failed'}`,
        type: !recovered && environment.environment.protection === 'production'
          && (receipt.deployment.state === 'outcome_unknown' || !healthyIncumbent) ? 'blocked' : 'update',
        healthPhase: recovered ? 'recovered' : 'open', resolved: false,
        body: [`Deployment: ${receipt.deployment.id}. Outcome: ${receipt.deployment.state}.`,
          ...[...receipt.content.machineResults].sort((left, right) => left.machineId.localeCompare(right.machineId)).map(row =>
            `Machine ${row.machineId}: ${row.health}${row.restoration ? `; restoration ${row.restoration}` : ''}.`),
        ].join(' '), signal,
      }));
      await deliver({ receipt: committed, signal, controllerMachineId: environment.environment.controllerMachineId });
    } catch (error) {
      // The receipt has already settled. Alert availability cannot change its
      // result or authorize replay; another actual settlement is the next wake.
      if (!signal.aborted) logger.infoFile('[deploymentHealth] Settlement notice unavailable', {
        errorCode: error instanceof Error && 'code' in error ? error.code : 'notice_write_failed',
      });
    }
  };
}
