import { expect, it, vi } from 'vitest';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonExternalActionExecution } from '@/daemon/externalActions/execution';
import { createDaemonShutdownCancellationDomains } from '@/daemon/startup/shutdownCancellationDomains';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import * as installationStore from '@/daemon/identity/store';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const captured = vi.hoisted(() => ({ params: [] as unknown[] }));
// The credentialed factory stays real; this records the transport it hands the Action deps.
vi.mock(
  '@/session/actions/createCliActionExecutorFromCredentials',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/session/actions/createCliActionExecutorFromCredentials')
      >();
    return {
      ...original,
      createCliActionExecutorFromCredentials: ((
        params: Parameters<typeof createCliActionExecutorFromCredentials>[0],
      ) => {
        captured.params.push(params);
        return original.createCliActionExecutorFromCredentials(params);
      }) as typeof createCliActionExecutorFromCredentials,
    };
  },
);

function unmounted<T>(name: string): T {
  const unavailable = () => {
    throw new Error(`Unexpected daemon capability: ${name}`);
  };
  return new Proxy(unavailable, { get: unavailable }) as T;
}

it.each([
  { scenario: 'named Manage receiver', machineId: 'receiver', role: 'manage', admitted: true },
  { scenario: 'receiver shared only for Use', machineId: 'receiver', role: 'use', admitted: false },
  { scenario: 'Machine the review did not name', machineId: 'elsewhere', role: 'manage', admitted: false },
] as const)('admits the Backup receiver Setup child at the receiving executor only for the $scenario', async ({ machineId, role, admitted }) => {
  const credentials = {
    token: `e30.${Buffer.from(JSON.stringify({ sub: 'person' })).toString('base64url')}.signature`,
    encryption: null,
  };
  const homeId = 'srv_backup_home';
  const target = { kind: 'machine' as const, machineId: 'source' };
  const rootInput = { serverId: homeId, environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
    destinationSetup: { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'receiver-installation', receiverInputs: {} },
    configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
      config: { path: '/private/repository' }, credentialBindings: [],
      sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
      ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
  const envelope = { v: 1 as const, requestId: 'backup-configure', target, input: rootInput };
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-backup', binding: {
    accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'source', installationId: 'source-installation',
    actionId: 'deployments.backups.configure', requestId: envelope.requestId, target, environmentId: 'environment',
    deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', rootInput),
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const input = { homeId, machineId };
  const method = `${machineId}:${RPC_METHODS.MACHINE_SETUP_PLAN}`;
  // The installed identity file is the OS boundary; admission matching stays real.
  vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(
    { installationId: `${machineId}-installation` } as ReturnType<typeof installationStore.readInstallationIdentityIfExistsSync>);
  const apiMachine = new Proxy({}, { get: () => vi.fn() }) as never;
  const isCallerCurrent = async () => true;
  const createExternal = createDaemonExternalActionExecution({
    params: {
      machineId, serverId: 'home', serverBaseUrl: 'https://home.invalid', credentials,
      getApiMachineForSessions: () => apiMachine,
      resolveServerFeaturesSnapshot: () => ({ status: 'unavailable' }) as never,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: homeId }) as never,
    },
    requiresPortableSessionSpawnServerIdentity: () => false,
    requesterAccountOperationContext: unmounted('requesterAccountOperationContext'),
    acquireDaemonPluginRuntimeRegistryLease: unmounted('pluginRegistry'),
    shutdownCancellationDomains: createDaemonShutdownCancellationDomains(),
    isSessionCallerCurrent: isCallerCurrent,
    externalActionApprovalExecutionOriginCurrentness: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
      credentials, serverId: 'home', serverApiUrl: 'https://home.invalid', machineId, isSessionCallerCurrent: isCallerCurrent }),
    externalActionIngressOwner: undefined,
    externalActionContributedApprovalReplay: null,
    observeContributedPluginExecution: unmounted('pluginExecution'),
    relayDiscussionAgentPublication: unmounted('discussion'),
    externalActionInstallationIdentity: null,
    ownerRemainder: unmounted('processRemainder'),
    isRuntimePublicationQuiescing: unmounted('publication'),
    pluginRuntimeController: unmounted('plugins'),
    connectedAccountRequestAuthRegistry: unmounted('connectedAccounts'),
    requireConnectedAccountRequestAuthHttpPort: unmounted('connectedAccountHttp'),
    localServicesActionFeatureGate: unmounted('localServicesGate'),
    localServicesRuntimeActionRoutes: unmounted('localServicesRoutes'),
    localServicesRuntime: unmounted('localServices'),
    externalActionContributedInvoker: null,
    externalActionContributedDefinitionLister: null,
    externalActionTranscriptFollowLeaseRegistry: null,
  });
  const external = createExternal(credentials, () => 0, isCallerCurrent, undefined, null);
  const result = await Promise.resolve(external.execute('machines.setup.plan', input, {
    surface: 'rpc', authority: 'account_automation', actionRequestId: 'receiver-plan',
    externalActionExecutionAuthorization: root, externalActionTarget: target, originalActionEnvelope: envelope,
    machineAdmission: { actorAccountId: 'person', custodianAccountId: 'bob', machineId,
      installationId: `${machineId}-installation`, role, encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true,
    workspaceSyncSourceExecution: { method, requestId: 'receiver-plan', params: input, originalActionEnvelope: envelope,
      externalActionExecution: { v: 1, authorization: root, effectActionId: 'machines.setup.plan', target,
        installationId: 'source-installation', machineSignature: 'A'.repeat(86),
        reviewedChild: { actionId: 'machines.setup.plan', role: BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.role,
          inputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', input) } } },
  } as never)).catch((error: unknown) => error);
  // A refused child stops at this executor's admission; an admitted one proceeds to the native Setup owner.
  expect(JSON.stringify(result).includes('target_binding_mismatch'), JSON.stringify(result)).toBe(!admitted);
  vi.restoreAllMocks();
});
