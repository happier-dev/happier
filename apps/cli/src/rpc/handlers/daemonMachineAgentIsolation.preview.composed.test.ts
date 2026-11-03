import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { createDaemonControlApp } from '@/daemon/controlServer';
import * as sockets from '@/api/session/sockets';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';

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
    ephemeralRunnerActivation: { findFirst: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['ephemeralRunnerActivation']['findFirst']>) => database.current!.db.ephemeralRunnerActivation.findFirst(...args) },
    simpleCache: { findUnique: async () => {
      if (!database.homeServerIdentityId) throw new Error('Missing Home identity database fact');
      return { value: database.homeServerIdentityId };
    } },
    $transaction: <T>(operation: (tx: ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']) => Promise<T>) => database.current!.db.$transaction(operation),
  },
  getDbProviderFromEnv: () => 'postgres',
}));

afterEach(() => { database.current = null; database.homeServerIdentityId = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const actionId = 'machines.agentIsolation.preview';
// Missing Machine metadata/setup effects must settle as typed unavailable after admission.
const observedStatus = { kind: 'unavailable' as const, code: 'metadata_unavailable' as const };

async function installedPreview() {
  const f = await createInstalledFilesystemMachineFixture();
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
    transportOwnerAccountId: 'requester', ui: { installation: f.installation }, methods: [actionId, 'machines.agentIsolation.set'] });
  return { ...f, relay };
}

describe('installed Machine isolation preview admission', () => {
  it('admits the fresh installed owner mutation and refuses Use and foreign requesters', async () => {
    const f = await installedPreview();
    const input = { serverId: f.homeServerIdentityId, machineId: f.machineId, enabled: true,
      expectedPolicy: { enabled: false }, expectedMetadataVersion: 0, expectedPlanDigest: 'reviewed-plan' };
    expect(await f.relay.invokeUi('machines.agentIsolation.set', input))
      .toMatchObject({ kind: 'failed', code: 'unavailable' });
    expect(await f.relay.invokeUi('machines.agentIsolation.set', input, { actorAccountId: 'member-use' }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(await f.relay.invokeUi('machines.agentIsolation.set', input, { actorAccountId: 'foreign-account' }))
      .toHaveProperty('errorCode');
  });

  it('previews absent isolation through authenticated Home admission and refuses a foreign Home', async () => {
    const f = await installedPreview();
    const input = { serverId: f.homeServerIdentityId, machineId: f.machineId, enabled: true };
    expect(await f.relay.invokeUi('machines.agentIsolation.preview', input)).toMatchObject({
      kind: 'unavailable', status: { kind: 'unavailable', code: 'metadata_unavailable' },
    });
    expect(await f.relay.invokeUi('machines.agentIsolation.preview', { ...input, serverId: 'srv_unrelated_home' }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(await f.relay.invokeUi('machines.agentIsolation.preview', input, { actorAccountId: 'member-use' }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });

  it('previews absent isolation through root-control receiving Home admission', async () => {
    const f = await installedPreview();
    const credentials = { token: f.bootstrap.credentials.token, encryption: null, credentialProvenance: 'stored_session' as const };
    const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: f.serverId, serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
      externalActionMachineInstallationId: f.installation.installationId, externalActionMachineRequestPrivateKey: f.installation.privateKey,
      machineActionDirectTargetTransport: { machineId: f.machineId,
        invoke: (method, request, options) => f.rpcHandlerManager.invokeLocal(method, request, options) } });
    const target = { kind: 'machine' as const, machineId: f.machineId };
    const app = createDaemonControlApp({ getChildren: () => [], machineId: f.machineId, controlToken: 'fixture-control',
      stopSession: async () => { throw new Error('No process stop expected'); }, spawnSession: async () => { throw new Error('No spawn expected'); },
      requestShutdown() { throw new Error('No shutdown expected'); }, onHappySessionWebhook() {},
      externalActionApi: { currentServerId: f.serverId, currentAccountId: 'requester', executor: receiver,
        verifyPat: async () => { throw new Error('No PAT expected'); }, resolveTarget: async () => target } });
    onTestFinished(() => app.close());
    const currentnessConnection = vi.mocked(sockets.createUserScopedSocketConnection).getMockImplementation();
    if (!currentnessConnection) throw new Error('Missing requester currentness socket boundary');
    vi.mocked(sockets.createUserScopedSocketConnection).mockImplementation(options => {
      if (options.clientPurpose !== 'scoped-rpc') return currentnessConnection(options);
      const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
          || !('method' in payload) || typeof payload.method !== 'string' || !payload.method.startsWith(`${f.machineId}:`)
          || !('params' in payload)) throw new Error('Unexpected isolation socket event');
        return f.relay.invokeUiRaw(payload.method.slice(`${f.machineId}:`.length), payload.params, { packet: payload });
      } });
      // Socket.IO is the network boundary; Home CALL and receiving admission stay real.
      return { socket, transport: { connect: async () => { socket.connect(); }, destroy: async () => { socket.disconnect(); },
        onDisconnected: () => () => {} } } as unknown as ReturnType<typeof sockets.createUserScopedSocketConnection>;
    });
    const response = await app.inject({ method: 'POST', url: '/actions/root/execute',
      headers: { 'x-happier-daemon-token': 'fixture-control' },
      payload: { actionId: 'machines.agentIsolation.preview', target,
        input: { serverId: f.homeServerIdentityId, machineId: f.machineId, enabled: true } } });
    expect(response.json()).toEqual({ ok: true, result: { kind: 'unavailable', status: observedStatus } });
  });
});
