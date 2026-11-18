import axios from 'axios';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { ExternalActionExecutionAuthorizationBindingV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionMachineRpcExecutionV1Schema, ExternalActionRequestEnvelopeSchema, type ExternalActionExecutionAuthorizationBindingV1,
  type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import * as control from '@/daemon/controlClient';
import * as publication from '@/daemon/multiDaemon';
import * as sockets from '@/api/session/sockets';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { updateSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const database = vi.hoisted(() => ({ current: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null,
  homeServerIdentityId: null as string | null }));
// Persistence is the boundary; Home computes roles and admission from these facts.
vi.mock('../../../../server/sources/storage/db', () => ({
  db: {
    machine: {
      findFirst: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findFirst']>) => database.current!.db.machine.findFirst(...args),
      findUnique: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findUnique']>) => database.current!.db.machine.findUnique(...args),
      findMany: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findMany']>) => database.current!.db.machine.findMany(...args),
    },
    account: { findUnique: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['account']['findUnique']>) => database.current!.db.account.findUnique(...args) },
    // The real Home sign-in policy reads both absent singleton rows in one PostgreSQL statement.
    $queryRawUnsafe: async (sql: string) => {
      if (!sql.includes('LEFT JOIN "HomeSettings"') || !sql.includes('LEFT JOIN "HomeGovernancePolicy"')) {
        throw new Error('Unexpected Home policy query');
      }
      return [{ revision: null, values: null, encryptedSecrets: null, authenticationPolicy: null }];
    },
    simpleCache: { findUnique: async () => {
      if (!database.homeServerIdentityId) throw new Error('Missing Home identity database fact');
      return { value: database.homeServerIdentityId };
    } },
    $transaction: <T>(operation: (tx: ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']) => Promise<T>) => database.current!.db.$transaction(operation),
  },
  getDbProviderFromEnv: () => 'postgres',
}));

afterEach(() => { database.current = null; database.homeServerIdentityId = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const actionId = 'machines.agentIsolation.status';
// This receiver has no Machine metadata or native setup effects. Admission
// must still report owner/Manage trust and an honest unavailable Use observation.
const observedStatus = { kind: 'unavailable' as const, code: 'metadata_unavailable' as const };

async function installedStatus(accountSettings?: Readonly<Record<string, unknown>>) {
  const f = await createInstalledFilesystemMachineFixture({ ...(accountSettings ? { accountSettings } : {}) });
  database.current = createInstalledMachineRpcDatabaseBoundary({ machineId: f.machineId, ownerAccountId: 'requester',
    installation: f.installation, members: [{ accountId: 'member-use', accessLevel: 'view' }, { accountId: 'member-manage', accessLevel: 'admin' }] });
  database.homeServerIdentityId = f.homeServerIdentityId;
  const readAccount = database.current.db.account.findUnique;
  database.current.db.account.findUnique = async query => {
    const account = await readAccount(query);
    return account ? { ...account, tokenEpoch: 1 } : null;
  };
  // Shared plain Machines must publish a valid safe projection before Home
  // admits members; the default empty DB blob deliberately cannot prove that.
  database.current.machine.metadata = encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
    host: 'status-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/status', happyHomeDir: '/home/status/.happier',
  }));
  const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: f.machineId,
    transportOwnerAccountId: 'requester', ui: { installation: f.installation }, methods: [actionId, RPC_METHODS.BASH] });
  return { ...f, relay };
}

describe('installed own Machine isolation status admission', () => {
  it('keeps owner and member own reads usable through Home, accepts its held identity, and refuses foreign or unstamped targets', async () => {
    const f = await installedStatus();
    const input = { serverId: f.serverId, machineId: f.machineId };
    expect(f.serverId).not.toBe(f.homeServerIdentityId);
    expect(await f.relay.invokeUi(actionId, input)).toEqual({ protection: 'trusted_administrator', status: observedStatus });
    expect.soft(await f.relay.invokeUi(actionId, { ...input, serverId: f.homeServerIdentityId }))
      .toEqual({ protection: 'trusted_administrator', status: observedStatus });
    for (const [actorAccountId, protection] of [['member-use', 'unavailable'], ['member-manage', 'trusted_administrator']] as const) {
      const result = await f.relay.invokeUi(actionId, input, { actorAccountId });
      expect(result).toEqual({ protection, status: observedStatus });
      expect(JSON.stringify(result)).not.toContain(actorAccountId);
    }
    expect(await f.relay.invokeUi(actionId, input, { actorAccountId: 'foreign-account' })).toHaveProperty('errorCode');
    expect(await f.receive({ method: `${f.machineId}:${actionId}`, params: input, callerAuthority: 'present_user' }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(await f.relay.invokeUi(actionId, { ...input, serverId: 'srv_unrelated_home' }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    database.current!.machine.installationId = 'replacement-installation';
    expect(await f.relay.invokeUi(actionId, input)).toHaveProperty('errorCode');
  });

  it.each(['machines.agentIsolation.status', 'machines.command.run'] as const)(
    'serves %s through stored-account public own-client and root-control receiving Home admission', async actionId => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'machines.command.run': ['cli'] } });
    const f = await installedStatus({ actionsSettingsV1: settings });
    const input = actionId === 'machines.command.run' ? { command: 'echo public-command-admitted' }
      : { serverId: f.serverId, machineId: f.machineId };
    const expected = actionId === 'machines.command.run'
      ? { exitCode: 0, stdout: expect.stringContaining('public-command-admitted'), stderr: '' }
      : { protection: 'trusted_administrator', status: observedStatus };
    const expectedResponse = actionId === 'machines.command.run'
      ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }
      : { ok: true, result: expected };
    const beforeAutomation = actionId === 'machines.command.run' ? {
      automationId: 'automation-before', triggerId: 'before', triggerRevision: 1,
      workflowId: 'workflow-before', workflowRevision: 1, ownerAccountId: 'requester',
      actionIds: ['machines.command.run'], phase: 'before', mode: 'wait', onFailure: 'refuse',
    } as const : null;
    const authEnv = createEnvKeyScope(['HANDY_MASTER_SECRET', 'HAPPIER_SERVER_IDENTITY_ID']);
    authEnv.patch({ HANDY_MASTER_SECRET: 'machine-status-composed-test', HAPPIER_SERVER_IDENTITY_ID: '' });
    onTestFinished(() => authEnv.restore());
    // Use the actual Home issuer, including current Account epoch and installed
    // Machine custody; only its HTTP and persistence boundaries are represented.
    const authPath = '../../../../server/sources/app/auth/auth';
    const { auth }: Readonly<{ auth: {
      init(): Promise<void>;
      mintExternalActionExecutionAuthorization(binding: ExternalActionExecutionAuthorizationBindingV1,
        context: Readonly<{ input: unknown }>): Promise<ExternalActionExecutionAuthorizationV1>;
    } }> = await import(authPath);
    await auth.init();
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    await updateSettings(current => ({ ...current, machineIdByServerId: { ...current.machineIdByServerId, [f.serverId]: f.machineId },
      servers: { ...current.servers, [f.serverId]: { id: f.serverId, name: 'Status Home', serverUrl: f.serverHttpBaseUrl,
        webappUrl: f.serverHttpBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: f.homeServerIdentityId,
          canonicalServerUrl: f.serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: f.serverHttpBaseUrl }] }) } } }));
    await writeStoredCredentialsForServerId(f.serverId, credentials);
    const receiver = createCliActionExecutor({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => settings },
      serverId: f.serverId, serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
      externalActionMachineInstallationId: f.installation.installationId, externalActionMachineRequestPrivateKey: f.installation.privateKey,
      machineActionDirectTargetTransport: { machineId: f.machineId,
        invoke: (method, request, options) => f.rpcHandlerManager.invokeLocal(method, request, options) } });
    const target = { kind: 'machine' as const, machineId: f.machineId,
      ...(actionId === 'machines.command.run' ? { project: { machineId: f.machineId, directory: f.directory } } : {}) };
    const publicationFacts = { pid: process.pid, httpPort: 4321, controlToken: 'fixture-control', accountId: 'requester', machineId: f.machineId };
    vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue(publicationFacts);
    vi.spyOn(publication, 'resolveLiveDaemonExternalActionEndpoint').mockResolvedValue(publicationFacts);
    const app = createDaemonControlApp({ getChildren: () => [], machineId: f.machineId, controlToken: 'fixture-control',
      stopSession: async () => { throw new Error('No process stop expected'); }, spawnSession: async () => { throw new Error('No spawn expected'); },
      requestShutdown() { throw new Error('No shutdown expected'); }, onHappySessionWebhook() {},
      externalActionApi: { currentServerId: f.serverId, currentAccountId: 'requester', executor: receiver,
        verifyPat: async () => { throw new Error('No PAT expected'); }, resolveTarget: async () => target } });
    onTestFinished(() => app.close());
    vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async request =>
      (await app.inject({ method: 'POST', url: '/actions/root/execute', headers: { 'x-happier-daemon-token': 'fixture-control' }, payload: request })).json());

    const currentnessConnection = vi.mocked(sockets.createUserScopedSocketConnection).getMockImplementation();
    if (!currentnessConnection) throw new Error('Missing requester currentness socket boundary');
    const signedCalls: Readonly<{ method: string; params: unknown; packet: Readonly<object>;
      execution: ReturnType<typeof ExternalActionMachineRpcExecutionV1Schema.parse> }>[] = [];
    vi.mocked(sockets.createUserScopedSocketConnection).mockImplementation(options => {
      if (options.clientPurpose !== 'scoped-rpc') return currentnessConnection(options);
      // The Account socket network boundary forwards into the actual Home CALL
      // handler. callMachineRpc, Home roles/currentness and the receiver stay real.
      const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
          || !('method' in payload) || typeof payload.method !== 'string' || !payload.method.startsWith(`${f.machineId}:`)
          || !('params' in payload)) throw new Error('Unexpected status socket event');
        if ('externalActionExecution' in payload) signedCalls.push({ method: payload.method, params: payload.params, packet: payload,
          execution: ExternalActionMachineRpcExecutionV1Schema.parse(payload.externalActionExecution) });
        return f.relay.invokeUiRaw(payload.method.slice(`${f.machineId}:`.length), payload.params, { packet: payload });
      } });
      // Socket.IO is the external typed boundary represented by the canonical stub.
      return { socket, transport: { connect: async () => { socket.connect(); }, destroy: async () => { socket.disconnect(); },
        onDisconnected: () => () => {} } } as unknown as ReturnType<typeof sockets.createUserScopedSocketConnection>;
    });
    const getHome = vi.mocked(axios.get).getMockImplementation();
    const postHome = vi.mocked(axios.post).getMockImplementation();
    if (!getHome || !postHome) throw new Error('Missing Home HTTP boundary');
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      if (beforeAutomation && String(url).endsWith(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)) {
        return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [beforeAutomation] }) };
      }
      if (String(url).endsWith('/v1/machines')) return { status: 200, data: [{ id: f.machineId, kind: 'persistent', active: true,
        revokedAt: null, replacedByMachineId: null, installationId: f.installation.installationId,
        access: { custodian: { accountId: 'requester', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] };
      const response = await getHome(url, options);
      if (String(url).endsWith(`/v1/machines/${f.machineId}`)) Object.assign(response.data.machine, {
        kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
        installationPublicKey: Buffer.from(f.installation.publicKey, 'base64url').toString('base64'),
      });
      return response;
    });
    vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
      const path = new URL(String(url)).pathname;
      if (beforeAutomation && path.endsWith('/v1/automations/actions/admit')) {
        return { status: 200, data: { results: [] } };
      }
      if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
      if (path.endsWith('/execution-authorization')) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const envelope = ExternalActionRequestEnvelopeSchema.parse(request.envelope);
        return { status: 200, data: await auth.mintExternalActionExecutionAuthorization(
          ExternalActionExecutionAuthorizationBindingV1Schema.parse({ serverIdentityId: f.homeServerIdentityId, accountId: 'requester', custodianAccountId: 'requester',
            authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain', machineId: f.machineId,
            installationId: f.installation.installationId, actionId, requestId: envelope.requestId, target: envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }),
          { input: envelope.v === 1 ? envelope.input : undefined }) };
      }
      if (path.endsWith(`/actions/${actionId}`)) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const result = await executeExternalAction({ actionId, envelope: request.envelope, executionAuthorization: request.executionAuthorization,
          principal: { accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, authority: 'present_user' },
          currentMachineId: f.machineId, currentAccountId: 'requester', currentServerId: f.serverId,
          currentServerHttpBaseUrl: f.serverHttpBaseUrl, currentInstallationId: f.installation.installationId,
          externalActionMachineRequestPrivateKey: f.installation.privateKey,
          verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
            privateKey: f.installation.privateKey, installationId: f.installation.installationId, serverHttpBaseUrl: f.serverHttpBaseUrl }),
          resolveTarget: async () => target, executor: receiver, surface: 'cli',
          prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input, purpose: { kind: 'external_action' },
            machineId: f.machineId, installationId: f.installation.installationId,
            installationPrivateKey: decodeBase64(f.installation.privateKey, 'base64url'),
            serverId: f.serverId, serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
            ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => receiver }) });
        if (result.kind !== 'response') throw new Error('Home status delivery was not admitted');
        return { status: 200, data: result.response };
      }
      return postHome(url, body, options);
    });
    const automationRequests: string[] = [];
    if (beforeAutomation) {
      vi.spyOn(axios, 'request').mockImplementation(async config => {
        const url = String(config.url);
        automationRequests.push(url);
        if (url.endsWith(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)) {
          return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [beforeAutomation] }) } as never;
        }
        if (url.endsWith('/v1/automations/actions/admit')) {
          return { status: 200, data: { results: [] } } as never;
        }
        throw new Error(`Unexpected automation request: ${config.method ?? 'GET'} ${url}`);
      });
    }
    const caller = createCliActionExecutorFromCredentials({ credentials, serverId: f.serverId, serverApiUrl: f.serverHttpBaseUrl,
      serverIdentityId: f.homeServerIdentityId, externalActionClient: true, actionsSettingsProvider: { getActionsSettings: () => settings } });
    const publicResult = await caller.execute(actionId, input, { surface: 'cli', externalActionTarget: target });
    expect.soft(publicResult).toEqual(expectedResponse);
    if (beforeAutomation) {
      expect(automationRequests.some(url => url.endsWith(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1))).toBe(true);
      expect(automationRequests.some(url => url.endsWith('/v1/automations/actions/admit'))).toBe(true);
    }
    const signedCall = signedCalls.at(-1);
    if (!signedCall) throw new Error(`Public ${actionId} did not reach signed Home CALL`);
    // Keep the complete real carrier and alter only its Home authorization.
    // A bridge that drops the proof would incorrectly admit this replay.
    const corruptedPacket = { ...signedCall.packet, externalActionExecution: { ...signedCall.execution,
      authorization: { ...signedCall.execution.authorization, token: 'invalid-status-proof' } } };
    expect(await f.relay.invokeUiRaw(signedCall.method.slice(`${f.machineId}:`.length), signedCall.params,
      { packet: corruptedPacket })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect((await app.inject({ method: 'POST', url: '/actions/root/execute', headers: { 'x-happier-daemon-token': 'fixture-control' },
      payload: { actionId, input, target } })).json())
      .toEqual(expectedResponse);
    expect(f.admissionChecks()).toBeGreaterThan(0);
  });
});
