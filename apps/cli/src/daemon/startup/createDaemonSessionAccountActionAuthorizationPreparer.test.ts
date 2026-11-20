import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { AccountProfileSchema, AccountSettingsSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { configuration } from '@/configuration';
import * as installationStore from '@/daemon/identity/store';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readStoredCredentialsForServerId, updateSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createMachineInstallationIdentityFixture } from '../../../../../packages/tests/src/testkit/machineIdentity';
import { createDaemonSessionAccountActionAuthorizationPreparer } from './createDaemonSessionAccountActionAuthorizationPreparer';
import { createDaemonSessionAccountActionExecutor } from '../agentRuntime/createDaemonSessionAccountActionExecutor';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

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
  return { run, isCallerCurrent, prepare, token };
}

describe('native Session command workspace admission', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['current workspace', 'missing workspace', 'another Machine'] as const)(
    'signs only the authenticated caller workspace for a native command (%s)', async shape => {
      const { prepare, token } = prepareFrom(sessionMachineId, true);
      const sessionId = 'agent-session';
      const actionId = 'machines.command.run';
      const machineId = shape === 'another Machine' ? controllerMachineId : sessionMachineId;
      // Home HTTP is the boundary; Session metadata opening, workspace
      // selection, native admission and the installation signer stay real.
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        switch (new URL(String(url)).pathname) {
          case '/v1/account/profile': return { status: 200, data: { id: 'owner' } };
          case '/v1/account/encryption/currentness':
            return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
          case `/v2/sessions/${sessionId}`:
            return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
              encryptionMode: 'plain', share: null,
              metadata: JSON.stringify({ machineId, ...(shape === 'missing workspace' ? {} : { path: '/workspace' }),
                permissionMode: 'default' }),
            }) } };
          default: throw new Error(`Unexpected Home GET ${url}`);
        }
      });
      const minted: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>[] = [];
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        expect(new URL(String(url)).pathname).toBe(bindExternalActionExecutionAuthorizationHttpPathV1(actionId));
        minted.push(ExternalActionExecutionAuthorizationRequestV1Schema.parse(body));
        // Home refuses the effect after observing the exact signed proposal.
        return { status: 403, data: { error: 'credential_scope_denied' } };
      });
      const execute = createDaemonSessionAccountActionExecutor({
        serverId: 'srv_home', serverHttpBaseUrl: 'https://home.invalid', token, machineId: sessionMachineId,
        credentials: { token, encryption: null }, readAccountEncryptionMode: async () => 'plain',
        prepareExternalActionAuthorization: prepare,
        createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()),
      });
      const result = await execute({ kind: 'action.execute', actionId, input: { command: 'echo checked' },
        requestId: 'native-command', surface: 'agent',
        witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
          agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } },
      }, { sessionId, isCurrent: async () => true });
      if (shape === 'current workspace') {
        expect(minted, JSON.stringify(result)).toMatchObject([{ machineId: sessionMachineId,
          envelope: { target: { kind: 'machine', machineId: sessionMachineId,
            project: { machineId: sessionMachineId, directory: '/workspace' } } } }]);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      } else {
        expect(minted, JSON.stringify(result)).toEqual([]);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      }
    });
});

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

describe('createDaemonSessionAccountActionAuthorizationPreparer managed acquisition', () => {
  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.restoreAllMocks();
  });

  it.each(['exact attribution', 'changed attribution'] as const)(
    'prepares an attributed Session acquisition only with an exact Home binding (%s)',
    async attributionCase => withConfiguredDaemonTestHome({ prefix: 'managed-session-authorization-' }, async () => {
      const { activeServerId: serverId } = configuration;
      const serverHttpBaseUrl = 'https://home.invalid';
      const homeId = 'srv_home';
      const accountId = 'owner';
      const machineId = controllerMachineId;
      const sessionId = 'c111111111111111111111111';
      const actionId = 'machines.managed.acquire';
      const requestId = 'session-acquire';
      const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
      await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: {
        id: serverId, name: 'Home', serverUrl: serverHttpBaseUrl, webappUrl: serverHttpBaseUrl,
        createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverHttpBaseUrl,
          revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] },
      } } }));
      await writeStoredCredentialsForServerId(serverId, { token, encryption: null });
      const credentials = await readStoredCredentialsForServerId(serverId);
      if (!credentials) throw new Error('Expected persisted Session credentials');
      setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const { installationId } = await installationStore.readOrCreateInstallationIdentity();
      const actionRequestAttributionV1 = { requestRef: 'authenticated-message', requester: { serverId: homeId, accountId },
        persona: { serverId: homeId, sessionId }, origin: null };
      const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({
        v: 1, caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn', sourceInputId: 'input', callerPermissionMode: 'default',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
        actionRequestAttributionV1, requestId,
      });
      const input = { enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, selection: {
        kind: 'one-off', homeId, controller: { machineId, installationId },
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      } };
      const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } } });
      // Substitute Home HTTP. The preparer still signs requests and qualifies the persisted Session and Installation.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        switch (new URL(String(url)).pathname) {
          case '/v1/account/profile': return { status: 200, data: AccountProfileSchema.parse({ id: accountId }) };
          case '/v1/account/encryption/currentness':
            return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
          case `/v2/sessions/${sessionId}`:
            return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null,
              metadata: JSON.stringify({ machineId, path: '/repo', permissionMode: 'default' }) }) } };
          case `/v1/machines/${machineId}`:
            return { status: 200, data: { machine: MachinePublishedRowV1Schema.parse({ id: machineId, installationId,
              managedMachineRef: null, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
              access: { custodian: { accountId, displayName: accountId }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            }) } };
          default: throw new Error(`Unexpected Home GET ${url}`);
        }
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
        expect(new URL(String(url)).pathname).toBe(bindExternalActionExecutionAuthorizationHttpPathV1(actionId));
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { status: 200, data: { v: 1, token: 'home-proof', binding: {
          serverIdentityId: homeId, accountId, custodianAccountId: accountId, machineId, installationId,
          authentication: { kind: 'terminal', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
          actionId, requestId, target: request.envelope.target, sessionActionSource: { machineId, installationId },
          sessionActionOrigin: attributionCase === 'exact attribution' ? request.sessionActionOrigin : {
            ...request.sessionActionOrigin, actionRequestAttributionV1: { ...actionRequestAttributionV1, requestRef: 'different-message' },
          },
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } } };
      });
      const prepare = createDaemonSessionAccountActionAuthorizationPreparer({
        credentials, requesterRuntime: null, serverHttpBaseUrl, serverId, machineId, externalActionAccountId: accountId,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId }),
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
        isSessionCallerCurrent: async () => true, isRuntimeCurrent: () => true, readTrackedSessionAttribution: () => undefined,
      });
      const result = await prepare({ operation: { actionId, input, requestId, surface: 'agent' },
        authority: { sessionId, isCurrent: async () => true }, isCallerCurrent: async () => true, sessionActionOrigin });
      if (attributionCase === 'changed attribution') {
        expect(result).toMatchObject({ ok: false, details: { requiredFact: 'home_authorization_binding' } });
      } else {
        expect(result).toMatchObject({ authorization: { binding: { sessionActionOrigin },
          requesterHttpProjection: { accountId, serverIdentityId: homeId } } });
      }
    }),
  );
});
