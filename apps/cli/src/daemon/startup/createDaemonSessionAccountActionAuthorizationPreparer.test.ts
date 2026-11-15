import { afterEach, describe, expect, it, vi } from 'vitest';
import * as installationStore from '@/daemon/identity/store';
import { createDaemonSessionAccountActionAuthorizationPreparer } from './createDaemonSessionAccountActionAuthorizationPreparer';

const sessionMachineId = 'b08d44db-2e4e-4b4a-bab9-2c8612406c62';
const controllerMachineId = 'eadc2422-b42b-478d-97b1-af9b530d5f08';
const healthInput = {
  serverId: 'srv_home',
  environmentId: 'environment',
  targetLinkId: 'runtime-link',
  machineId: controllerMachineId,
};

function prepareFrom(machineId: string) {
  // Installation identity is the daemon's on-disk boundary; Home is never reached in these cases.
  vi.spyOn(
    installationStore,
    'readInstallationIdentityIfExistsSync',
  ).mockReturnValue({
    version: 1,
    installationId: 'installation',
    createdAt: 1,
    publicKey: 'public',
    privateKey: 'private',
  });
  const isCallerCurrent = vi.fn(async () => false);
  const prepare = createDaemonSessionAccountActionAuthorizationPreparer({
    credentials: { token: 'session-token', encryption: null },
    requesterRuntime: null,
    serverHttpBaseUrl: 'https://home.invalid',
    machineId,
    serverId: 'srv_home',
    resolveCurrentMachineExecutionOriginContext: async () => ({
      serverIdentityId: 'srv_home',
      machineId,
    }),
    isSessionCallerCurrent: async () => true,
    isRuntimeCurrent: () => true,
    readTrackedSessionAttribution: () => undefined,
  });
  const run = () =>
    prepare({
      operation: {
        actionId: 'deployments.health.current',
        input: healthInput,
        requestId: 'health-request',
        surface: 'agent',
      },
      authority: { sessionId: 'agent-session', isCurrent: async () => true },
      isCallerCurrent,
      sessionActionOrigin: {
        v: 1,
        caller: {
          kind: 'session',
          sessionId: 'agent-session',
          starterDepth: 0,
          turnDepth: 0,
        },
        sourceTurnId: 'turn',
        callerPermissionMode: null,
        requestId: 'health-request',
      },
    });
  return { run, isCallerCurrent };
}

describe('createDaemonSessionAccountActionAuthorizationPreparer deployment read placement', () => {
  afterEach(() => vi.restoreAllMocks());

  it('settles a controller health read from a Session on another Machine with a typed placement reason, before Home', async () => {
    const { run, isCallerCurrent } = prepareFrom(sessionMachineId);
    await expect(run()).resolves.toMatchObject({
      ok: false,
      errorCode: 'target_unavailable',
      details: {
        reason: 'read_receiver_placement',
        receiverMachineId: controllerMachineId,
        sessionMachineId,
        remedy: expect.stringContaining(controllerMachineId),
      },
    });
    expect(isCallerCurrent).not.toHaveBeenCalled();
  });

  it('lets a Session on the controller continue to the Home mint', async () => {
    const { run, isCallerCurrent } = prepareFrom(controllerMachineId);
    // The caller fence is the next step after placement; it refuses here only because this caller is stale.
    await expect(run()).resolves.toMatchObject({
      ok: false,
      details: { requiredFact: 'active_session_action' },
    });
    expect(isCallerCurrent).toHaveBeenCalledTimes(1);
  });
});
