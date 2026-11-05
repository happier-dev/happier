import { afterAll, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { startExplicitSessionStopRedisServer } from '../../../../../server/sources/testkit/explicitSessionStopRedisServer.testkit';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionStopResultSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataVersionConflictV1Schema, SessionOwnerMetadataEnvelopeV1Schema, projectSessionOwnerCompatibilityViewV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('expo-file-system', async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);

// The canonical Redis fixture resets modules. Start it before loading the UI
// singleton graph, so the Action and its Home use one Account/transport authority.
const fixture = await startExplicitSessionStopRedisServer({ targetNode: 1, installed: true,
    accountId: 'alice', machineId: 'machine-a', sessionId: 'stop-with-silent-peer' });
afterAll(() => fixture.close());

try {
// Rebind the canonical mock to the actual Socket namespace retained by Redis.
// No UI transport consumer has loaded yet.
await import('socket.io-client');
// Module collection is outside the Action's behavior deadline.
const { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
const { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createMachineFixture, createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
const configureSessionSocket: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['configureSocket']> = socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    // Redirect only the external cold-Home network boundary, preserving the
    // complete authorization payload into the real server and Redis adapter.
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => event === 'rpc-call'
        ? await fixture.call(payload) : { v: 1, ok: true, admittedSessionIds: [] });
};
installDisconnectedServerSocketBoundary(configureSessionSocket);
const homes = createHomeGovernanceHarness();
const readBatchRequest = createSessionReadBatchFetchBoundary(homes.request);
installHomeGovernanceBoundaries({ ...homes, request: readBatchRequest });
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';

function installSession(id: string, partialMetadata: Partial<NonNullable<ReturnType<typeof createSessionFixture>['metadata']>>, ownerServerId = serverId, layout: 0 | 1 = 0,
  initialRow?: ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture>) {
  const metadata = { path: '/repo', host: 'tester.local', ...partialMetadata };
  const session = createSessionFixture({ id, serverId: ownerServerId, active: true, metadata });
  storage.setState({ sessions: { ...storage.getState().sessions, [id]: session } });
  let row = SessionCurrentProjectionRecordV1Schema.parse({
    ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(metadata),
    effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
    responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
    agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
  });
  if (layout === 1) row = initialRow ?? createPlainSessionCurrentProjectionRecordFixture({ id, active: true, metadata });
  const answer = { select: (input: unknown) => {
    if (input === undefined || input === null) return { body: { session: row } };
    const patch = SessionMetadataTuplePatchV1Schema.parse(input);
    if (patch.mode === 'shared_editor') throw new Error('Owner mode change used shared-editor metadata');
    const target = patch.mode === 'owner_migration' ? patch.target : patch;
    // Mirror the real tuple producer: owner-only metadata changes do not bump
    // AgentState when its stored ciphertext is unchanged (sessionWriteService).
    const agentStateChanged = patch.mode === 'owner_migration' || row.agentState !== target.agentState.ciphertext;
    row = SessionCurrentProjectionRecordV1Schema.parse({ ...row,
      metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
      ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
      metadataVersion: row.metadataVersion + 1, agentStateVersion: (row.agentStateVersion ?? 0) + (agentStateChanged ? 1 : 0),
    });
    return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
  } };
  homes.answer(ownerServerId, `/v2/sessions/${id}`, answer);
  homes.answer(ownerServerId, `/v2/sessions/${id}?accessProjectionVersion=1`, answer);
  return () => row;
}

it('stops through the public Action and real Redis while an unrelated peer is silent', async () => {
    const webLocks = installWebLockManagerMock();
    try {
        await homes.reset();
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }) };
    serverId = await homes.addHome({ name: 'Mode Home', serverUrl: 'https://mode-actions.test', serverIdentityId: 'srv_mode_home', accountId: 'alice', credentials });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://mode-actions.test', serverIdentityId: 'srv_mode_home', accountId: 'alice', credentials,
      request: readBatchRequest, configureSocket: configureSessionSocket });
    storage.getState().activateProfileScope({ serverId: connection.serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId: connection.serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const machineRow = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' });
    const machine = createMachineFixture({ id: machineRow.id, activeAt: machineRow.activeAt,
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    homes.answer(serverId, '/v1/machines', { body: [machineRow] });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: machineRow } });

        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        await sync.refreshMachines();
        installSession(fixture.sessionId, { path: '/repo', machineId: fixture.machineId, flavor: 'codex' });
        const result = await createDefaultActionExecutor().execute('session.stop', { sessionId: fixture.sessionId },
            { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('Expected public Session stop confirmation');
        expect(SessionStopResultSchema.parse(result.result)).toMatchObject({ sessionId: fixture.sessionId, stopped: true });
        expect(fixture.stop).toHaveBeenCalledOnce();
        expect(await fixture.readSessionActive()).toBe(false);
        expect(fixture.heldCount).toBeGreaterThan(0);
    } finally {
        try {
            await connection?.dispose();
            serverScopedRpcSocketPool.resetForTests();
            resetScopedMachineTransportCacheForTests();
            await homes.reset();
            storage.setState(originalState, true);
            webLocks.restore();
            vi.restoreAllMocks();
        } finally {
            await fixture.close();
        }
    }
});

} catch (error) {
    await fixture.close();
    throw error;
}
