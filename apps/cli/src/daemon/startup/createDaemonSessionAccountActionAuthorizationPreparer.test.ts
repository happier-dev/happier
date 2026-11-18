import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import * as installationStore from '@/daemon/identity/store';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createMachineInstallationIdentityFixture } from '../../../../../packages/tests/src/testkit/machineIdentity';
import { createDaemonSessionAccountActionAuthorizationPreparer } from './createDaemonSessionAccountActionAuthorizationPreparer';

const sessionMachineId = 'b08d44db-2e4e-4b4a-bab9-2c8612406c62';
const controllerMachineId = 'eadc2422-b42b-478d-97b1-af9b530d5f08';
const healthInput = {
  serverId: 'srv_home',
  environmentId: 'environment',
  targetLinkId: 'runtime-link',
  machineId: controllerMachineId,
};

function prepareFrom(machineId: string, current = false) {
  // Substitute the on-disk Installation boundary and keep real request signing.
  const installation = createMachineInstallationIdentityFixture();
  vi.spyOn(
    installationStore,
    'readInstallationIdentityIfExistsSync',
  ).mockReturnValue({
    version: 1,
    installationId: installation.installationId,
    createdAt: 1,
    publicKey: Buffer.from(installation.publicKeyBase64, 'base64').toString('base64url'),
    privateKey: Buffer.from(installation.privateKeyBase64, 'base64').toString('base64url'),
  });
  const isCallerCurrent = vi.fn(async () => current);
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const prepare = createDaemonSessionAccountActionAuthorizationPreparer({
    credentials: { token, encryption: null },
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
  const run = (actionId: 'deployments.health.current' | 'deployments.restart' | 'deployments.targets.link' =
    'deployments.health.current', input: unknown = healthInput) =>
    prepare({
      operation: {
        actionId,
        input,
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

  it('lets a Session on another Machine continue to the Home mint for a read served by the controller', async () => {
    // The read is minted for its receiver and delivered through Home's admitted-root relay.
    const { run, isCallerCurrent } = prepareFrom(sessionMachineId);
    await expect(run()).resolves.toMatchObject({
      ok: false,
      details: { requiredFact: 'active_session_action' },
    });
    expect(isCallerCurrent).toHaveBeenCalledTimes(1);
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

  const linkedMachineId = '289fd84b-e42b-414b-a441-c004f04772a0';
  it.each([
    { actionId: 'deployments.restart' as const, receiver: linkedMachineId, reads: 0, input: {
      ...healthInput, machineId: linkedMachineId, installationId: 'installation',
      deploymentId: 'deployment', expectedGeneration: 'generation',
      service: { kind: 'deployment', machineId: linkedMachineId, environmentId: healthInput.environmentId,
        environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' },
    } },
    { actionId: 'deployments.targets.link' as const, receiver: controllerMachineId, reads: 1, input: {
      serverId: healthInput.serverId, environmentId: healthInput.environmentId, expectedRevision: 1,
      requestKey: 'link', targetId: 'example', role: 'data', machines: [], targetKind: 'database',
      source: { kind: 'plugin', contribution: { pluginId: 'example.data', localId: 'database' } },
      machineId: linkedMachineId, installationId: 'installation',
      contentArtifactId: 'private-link', contentHeaderVersion: 1, contentBodyVersion: 1,
    } },
  ])('proposes the right receiver to Home for $actionId', async ({ actionId, input, receiver, reads }) => {
    const { run } = prepareFrom(sessionMachineId, true);
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      switch (new URL(String(url)).pathname) {
        case '/v1/account/profile': return { status: 200, data: { id: 'owner' } };
        case '/v1/account/encryption/currentness':
          return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        default: throw new Error(`Unexpected Home GET ${url}`);
      }
    });
    const read = vi.spyOn(axios, 'request').mockImplementation(async config => {
      expect(new URL(String(config.url)).pathname).toBe('/v1/deployments/environments/environment');
      return { status: 200, data: { ok: true, environment: createDeploymentEnvironmentHeaderV1({
        serverId: healthInput.serverId, id: healthInput.environmentId, controllerMachineId,
      }), targetLinks: [] } };
    });
    const mint = vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: { error: 'credential_scope_denied' } });
    const result = await run(actionId, DeploymentActionInputSchemasV1[actionId].parse(input));
    const call = mint.mock.calls.find(([url]) => new URL(String(url)).pathname ===
      bindExternalActionExecutionAuthorizationHttpPathV1(actionId));
    expect(call?.[1], JSON.stringify(result)).toMatchObject({
      machineId: receiver, sessionActionSource: { machineId: sessionMachineId },
    });
    expect(read).toHaveBeenCalledTimes(reads);
  });
});
