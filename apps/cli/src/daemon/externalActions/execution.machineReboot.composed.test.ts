import { expect, it, vi } from 'vitest';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonExternalActionExecution } from '@/daemon/externalActions/execution';
import { createDaemonShutdownCancellationDomains } from '@/daemon/startup/shutdownCancellationDomains';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';

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

it('gives the credentialed receiver the receiving daemon Reboot owner, never a Machine RPC re-entry', async () => {
  const credentials = {
    token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
    encryption: null,
  };
  // The receiving daemon's API machine is the native lifecycle boundary.
  const executeMachineRebootAction = vi.fn(async () => ({
    kind: 'unavailable',
    reason: 'admission_unavailable',
  }));
  const apiMachine = new Proxy(
    { executeMachineRebootAction },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : vi.fn(),
    },
  ) as never;
  const isCallerCurrent = async () => true;
  const createExternal = createDaemonExternalActionExecution({
    params: {
      machineId: 'machine',
      serverId: 'home',
      serverBaseUrl: 'https://home.invalid',
      credentials,
      getApiMachineForSessions: () => apiMachine,
      resolveServerFeaturesSnapshot: () => ({ status: 'unavailable' }) as never,
    },
    requiresPortableSessionSpawnServerIdentity: () => false,
    requesterAccountOperationContext: unmounted(
      'requesterAccountOperationContext',
    ),
    acquireDaemonPluginRuntimeRegistryLease: unmounted('pluginRegistry'),
    shutdownCancellationDomains: createDaemonShutdownCancellationDomains(),
    isSessionCallerCurrent: isCallerCurrent,
    externalActionApprovalExecutionOriginCurrentness:
      createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
        credentials,
        serverId: 'home',
        serverApiUrl: 'https://home.invalid',
        machineId: 'machine',
        isSessionCallerCurrent: isCallerCurrent,
      }),
    externalActionIngressOwner: undefined,
    externalActionContributedApprovalReplay: null,
    observeContributedPluginExecution: unmounted('pluginExecution'),
    relayDiscussionAgentPublication: unmounted('discussion'),
    externalActionInstallationIdentity: null,
    ownerRemainder: unmounted('processRemainder'),
    isRuntimePublicationQuiescing: unmounted('publication'),
    pluginRuntimeController: unmounted('plugins'),
    connectedAccountRequestAuthRegistry: unmounted('connectedAccounts'),
    requireConnectedAccountRequestAuthHttpPort: unmounted(
      'connectedAccountHttp',
    ),
    localServicesActionFeatureGate: unmounted('localServicesGate'),
    localServicesRuntimeActionRoutes: unmounted('localServicesRoutes'),
    localServicesRuntime: unmounted('localServices'),
    externalActionContributedInvoker: null,
    externalActionContributedDefinitionLister: null,
    externalActionTranscriptFollowLeaseRegistry: null,
  });
  const external = createExternal(credentials, () => 0, isCallerCurrent, undefined, null);
  // The factory builds its Action deps per invocation; any refusal after that is irrelevant here.
  await Promise.resolve(external.execute('machines.reboot', { serverId: 'srv_home', machineId: 'machine',
    expectedInstallationId: 'installation' }, { surface: 'ui', authority: 'present_user', actionRequestId: 'reboot' })).catch(() => null);
  const transport = (
    captured.params.at(-1) as Parameters<
      typeof createCliActionExecutorFromCredentials
    >[0]
  ).machineActionDirectTargetTransport;
  expect(transport?.machineReboot).toBeTypeOf('function');
  const machineAdmission = {
    actorAccountId: 'owner',
    custodianAccountId: 'owner',
    machineId: 'machine',
    installationId: 'installation',
    role: 'manage',
    encryptionMode: 'plain',
  } as const;
  const verifyMachineAdmissionCurrent = async () => true;
  await transport!.machineReboot!({
    input: {
      serverId: 'srv_home',
      machineId: 'machine',
      expectedInstallationId: 'installation',
    },
    context: {
      surface: 'ui',
      authority: 'present_user',
      machineAdmission,
      verifyMachineAdmissionCurrent,
    } as never,
    canReadEnvironments: async () => true,
  });
  // The receiving owner gets this invocation's own Machine admission, so the approval origin survives.
  expect(executeMachineRebootAction).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({
        machineAdmission,
        verifyMachineAdmissionCurrent,
      }),
    }),
  );
});
