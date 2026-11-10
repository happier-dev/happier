import { SAVED_HEALTH_ALERT_TEST_ACTION_ID } from '@happier-dev/protocol/actions/notificationConfigurationActionIds';
import { createCredentialedAccountArtifactStore, projectServiceHealthNoticeNotification,
  type AccountNoticeWriteReceipt } from '@/api/artifacts/accountArtifactStore';
import { CommittedServiceHealthDeliveryRequestV1Schema, CommittedServiceHealthDeliveryResultV1Schema,
  readAccountNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { PushNotificationClient } from '@/api/pushNotifications';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import type { HealthCheckSourceConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { dispatchActivityNotificationAsync } from './dispatchActivityNotification';
import { NotificationConfigurationActionInputSchemas } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';

/** Producer adapters supply current authority; C1 retains every delivery decision. */
export function createCommittedServiceHealthDelivery(host: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
}>) {
  let pushSender: PushNotificationClient | undefined;
  return async (input: Readonly<{
    receipt: AccountNoticeWriteReceipt;
    signal: AbortSignal;
    controllerMachineId: string | null | undefined;
    alerts?: HealthCheckSourceConfigV1['alerts'];
  }>) => {
    const suppressed = { kind: 'suppressed' as const };
    if (!input.receipt.changed || !input.receipt.healthOpening || input.signal.aborted) return suppressed;
    const opening = input.receipt.healthOpening;
    const controllerMachineId = input.controllerMachineId;
    if (!controllerMachineId || input.signal.aborted) return suppressed;
    if (controllerMachineId !== host.machineId) {
      // One exact hop, without reconnect replay or replacement-Machine fallback.
      // The receiver reopens this Account's private committed revision before
      // the same dispatcher can enumerate controller-side destinations.
      return CommittedServiceHealthDeliveryResultV1Schema.parse(await callExactMachineRpc({
        credentials: host.credentials, machineId: controllerMachineId, serverUrl: host.serverHttpBaseUrl,
        requireCurrentMachine: true, requiredMachineKind: 'persistent', authorityCeiling: 'account_automation',
        method: RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER, signal: input.signal,
        request: CommittedServiceHealthDeliveryRequestV1Schema.parse({ machineId: controllerMachineId,
          serverId: host.serverId, artifactId: input.receipt.artifactId, revision: input.receipt.revision,
          ...(input.alerts === undefined ? {} : { alerts: input.alerts }) }),
      }));
    }
    const settings = getActiveAccountSettingsSnapshot();
    if (!settings?.scopeKey || settings.scopeKey !== resolveAccountSettingsScopeKey(host.credentials)) return suppressed;
    const incumbent = { scopeKey: settings.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => dispatchActivityNotificationAsync({
      settings: settings.settings, event: opening, signal: input.signal,
      serviceHealthCommit: { receipt: input.receipt, machineId: host.machineId, controllerMachineId, alerts: input.alerts },
      isCurrent: async () => !input.signal.aborted && isActiveAccountSettingsSnapshotLifetimeCurrent(incumbent),
      expoPushSender: pushSender ??= new PushNotificationClient(host.credentials.token,
        host.serverHttpBaseUrl, host.serverId, host.serverHttpBaseUrl),
    }));
    return { kind: 'attempted' as const };
  };
}

/** Re-admits the same-Account controller hop; never writes or observes health. */
export function registerDaemonCommittedServiceHealthDeliveryRpcHandler(rpc: RpcHandlerRegistrar, host: Readonly<{
  target(): Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
  resolveRuntime(context: RpcHandlerContext): Promise<Readonly<{
    credentials: StoredCredentials; accountId: string; serverId: string; serverHttpBaseUrl: string; machineId: string;
    isCurrent?: () => boolean | Promise<boolean>;
  }> | null>;
}>) {
  rpc.registerHandler(RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER, async (raw: unknown, context) => {
    const testKind = raw !== null && typeof raw === 'object' && 'kind' in raw
      && (raw.kind === 'test' || raw.kind === 'prepareTest') ? raw.kind : null;
    const isTest = testKind !== null;
    const request = isTest ? NotificationConfigurationActionInputSchemas[SAVED_HEALTH_ALERT_TEST_ACTION_ID].parse(
      Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'kind')),
    ) : CommittedServiceHealthDeliveryRequestV1Schema.parse(raw);
    const target = host.target();
    const admission = context?.machineAdmission;
    // The RPC transport already admitted this installed target. This owner
    // narrows that admission to same-Account private notice delivery.
    if (!context || !target || !admission || admission.actorAccountId !== admission.custodianAccountId
      || !doesMachineRpcTargetMatchAdmission(request, admission, target)) {
      throw new RpcError('Current same-Account Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
    }
    const runtime = await host.resolveRuntime(context);
    if (!runtime || context.signal.aborted || runtime.accountId !== admission.actorAccountId
      || runtime.machineId !== target.machineId
      || !await isServerProfileHomeIdentity(runtime.serverId, request.serverId)) {
      throw new RpcError('Private notice custody is unavailable', RPC_ERROR_CODES.FORBIDDEN);
    }
    if ('sourceInstanceId' in request) {
      const { createSavedHealthAlertTestReceiverForHost, createSavedHealthAlertTestPreparationReceiverForHost } = await import('./savedHealthAlertDelivery');
      return (testKind === 'prepareTest' ? createSavedHealthAlertTestPreparationReceiverForHost(runtime)
        : createSavedHealthAlertTestReceiverForHost(runtime))(request, context.signal);
    }
    const store = createCredentialedAccountArtifactStore(runtime.credentials);
    // The private committed revision is the content source. Source access was
    // admitted by its producer's transition, not by each destination request.
    const artifact = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => store.read(request.artifactId, {
      signal: context.signal, prepareRecipients: false, includeSharedAudience: false,
    }));
    const notice = artifact ? readAccountNoticeArtifactV1(artifact) : null;
    if (!artifact || artifact.artifactId !== request.artifactId || artifact.ownerAccountId !== runtime.accountId
      || artifact.access !== 'owner' || artifact.publicAudience !== 'none'
      || artifact.revision.headerVersion !== request.revision.headerVersion || artifact.revision.bodyVersion !== request.revision.bodyVersion
      || !notice || notice.status !== 'open' || notice.resolved
      || (request.alerts === undefined ? notice.type !== 'blocked' || notice.healthPhase !== 'open'
        : notice.healthPhase !== 'open' && notice.healthPhase !== 'recovered')) {
      return { kind: 'suppressed' as const };
    }
    const opening = projectServiceHealthNoticeNotification({ header: notice, accountId: runtime.accountId, artifactId: artifact.artifactId });
    if (!opening?.data.serverId) return { kind: 'suppressed' as const };
    return createCommittedServiceHealthDelivery(runtime)({ receipt: { changed: true, artifactId: request.artifactId,
      revision: request.revision, healthOpening: { ...opening, data: { ...opening.data, serverUrl: runtime.serverHttpBaseUrl } } },
      signal: context.signal, controllerMachineId: target.machineId, alerts: request.alerts });
  });
}
