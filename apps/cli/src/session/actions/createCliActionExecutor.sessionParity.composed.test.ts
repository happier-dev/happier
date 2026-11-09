// Keep the real UI Account/Sync owners below their canonical native boundaries.
import '../../../../ui/sources/dev/vitestSetup';
import axios, { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, RPC_METHODS,
  SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
  SessionOwnerMetadataEnvelopeV1Schema, projectSessionOwnerCompatibilityViewV1, UiActionDispatchRequestV1Schema } from '@happier-dev/protocol';
import { SessionConnectedServiceAuthSwitchRpcParamsSchema } from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, createAccountTokenForTests } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture } from '../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '../../../../ui/sources/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '../../../../ui/sources/dev/testkit/cleanup/standardCleanup';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { installDaemonMachineAdmissionTransport } from '@/daemon/machineAdmissionTransport';
import { createClientActionReverseDispatcher } from './clientActionReverseDispatch';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

vi.mock('socket.io-client', async importOriginal =>
  (await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('../../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

let daemonAnswer: (method: string, params: unknown) => unknown;
installDisconnectedServerSocketBoundary(socket => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Invalid daemon RPC');
    }
    return { ok: true, result: await daemonAnswer(payload.method, payload.params) };
  });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await (await import('../../../../ui/sources/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
const { createUiClientActionReverseHandler } = await import('../../../../ui/sources/sync/ops/actions/clientActionReverseDispatch');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const accountId = 'session-parity-account';
const sessionId = 'c123456789012345678901234';
const machineId = 'session-parity-machine';
const credentials = { token: createAccountTokenForTests(accountId), encryption: null } as const;
const controls = ['session.config_option.set', 'session.connected_services_auth.set'] as const;

beforeEach(async () => {
  await homes.reset();
  serverId = await homes.addHome({ name: 'Session parity', serverUrl: 'https://session-parity.test', accountId });
  connection = await restoreServerAccountForTest({ serverUrl: 'https://session-parity.test', accountId, request: homes.request });
  installHomeGovernanceBoundaries(homes);
  // The CLI's Axios HTTP leaf shares the same Home fixtures as the UI fetch leaf.
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(AxiosHeaders.from(config?.headers).toJSON())) {
      if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
    const response = await homes.request(String(url), { method: 'GET', headers });
    return { status: response.status, data: await response.json() };
  });
  const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
    approvalWaivedSurfaces: Object.fromEntries(controls.map(id => [id, ['agent', 'mcp']])) } });
  storage.setState({ settings });
  homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
  const machine = createMachineFixture({ id: machineId, activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
  storage.setState(state => ({ profile: { ...state.profile!, id: accountId }, machines: { [machineId]: machine }, machineListByServerId: {} }));
  const machineRow = createPlainMachineRowFixture({ id: machineId, accountId });
  homes.answer(serverId, '/v1/machines', { body: [machineRow] });
  homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: machineRow } });
  daemonAnswer = () => { throw new Error('Unexpected daemon RPC'); };
});
afterEach(async () => {
  standardCleanup();
  if (connection) { await connection.dispose(); connection = undefined; }
  vi.restoreAllMocks();
});

describe('CLI current-Session control owners', () => {
  it.each(['agent', 'mcp'] as const)('writes client configuration and applies connected-account routing without a connected client on %s', async surface => {
    const metadata = { path: '/checkout', host: 'test', flavor: 'opencode', machineId,
      sessionConfigOptionsV1: { v: 1 as const, agentId: 'opencode', updatedAt: 1, configOptions: [{ id: 'effort',
        name: 'Thinking', type: 'select' as const, currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }] } };
    const session = createSessionFixture({ id: sessionId, serverId, active: true, metadata });
    storage.setState({ sessions: { [sessionId]: session } });
    let row = SessionCurrentProjectionRecordV1Schema.parse({ ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(metadata),
      effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
      responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null, agentState: null, dataEncryptionKey: null,
      pendingCount: 0, pendingVersion: 0 });
    const answer = { select: (input: unknown) => {
      if (input == null) return { body: { session: row } };
      const patch = SessionMetadataTuplePatchV1Schema.parse(input);
      if (patch.mode === 'shared_editor') throw new Error('Expected owner config write');
      const target = patch.mode === 'owner_migration' ? patch.target : patch;
      row = SessionCurrentProjectionRecordV1Schema.parse({ ...row, metadataLayoutVersion: 1,
        metadata: target.sharedMetadata.ciphertext, ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
        metadataVersion: row.metadataVersion + 1, agentStateVersion: (row.agentStateVersion ?? 0) + 1 });
      return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
    } };
    homes.answer(serverId, `/v2/sessions/${sessionId}`, answer);
    homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    const receive = createUiClientActionReverseHandler({ serverId, accountId, isCurrent: () => true });
    let connected = true;
    let current = true;
    const release = installDaemonMachineAdmissionTransport({ serverId,
      transport: async () => { throw new Error('Configuration must not enqueue Session input'); },
      clientActionExecute: createClientActionReverseDispatcher(() => ({
        hasConnectedClientRpcHandler: method => connected && method === RPC_METHODS.UI_ACTION_EXECUTE,
        // Only process/network delivery is replaced; both real executors,
        // Account lifetime capture, option validation and publication run.
        callConnectedClientRpc: async (_method, payload, options) => {
          if (!connected) return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
          UiActionDispatchRequestV1Schema.parse(payload);
          options.onIssued();
          return { ok: true, result: await (current ? receive : createUiClientActionReverseHandler({ serverId, accountId, isCurrent: () => false }))(
            payload, { signal: options.signal ?? new AbortController().signal }) };
        },
      })),
    });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_session_parity' } } });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl: 'https://session-parity.test',
      pluginActionExecutionOwner: 'current_process', serverIdentityId: 'srv_session_parity',
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features, provenance: 'authenticated' }),
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: storage.getState().settings }) });
    const context = { surface, authority: 'account_automation' as const, defaultSessionId: sessionId };
    const config = { sessionId, configId: 'effort', valueId: 'high' };
    const auth = { sessionId, machineId, serverId, agentId: 'external-agent', bindings: { v: 2 as const, bindingsByServiceId: {} } };
    const applied: unknown[] = [];
    daemonAnswer = (method, raw) => {
      expect(method).toBe(`${machineId}:${RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH}`);
      const input = SessionConnectedServiceAuthSwitchRpcParamsSchema.parse(raw);
      applied.push(input);
      return { ok: true, action: 'metadata_updated' };
    };
    try {
      expect(await executor.execute('session.config_option.set', config, context)).toMatchObject({ ok: true });
      const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
      if (owner.t !== 'plain') throw new Error('Expected plain Account metadata');
      const visible = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata), ownerMetadata: owner.v });
      expect(visible.acpConfigOptionOverridesV1).toMatchObject({ overrides: { effort: { value: 'high' } } });
      expect(await executor.execute('session.connected_services_auth.set', auth, context))
        .toEqual({ ok: true, result: { ok: true, action: 'metadata_updated' } });
      expect(applied).toEqual([expect.objectContaining({ sessionId, agentId: 'external-agent', bindings: auth.bindings })]);
      expect(await executor.execute('session.config_option.set', { ...config, valueId: 'unadvertised' }, context))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      current = false;
      expect(await executor.execute('session.connected_services_auth.set', auth, context))
        .toEqual({ ok: true, result: { ok: true, action: 'metadata_updated' } });
      connected = false;
      expect(await executor.execute('session.config_option.set', config, context))
        .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
      expect(await executor.execute('session.connected_services_auth.set', auth, context))
        .toEqual({ ok: true, result: { ok: true, action: 'metadata_updated' } });
      expect(applied).toHaveLength(3);
    } finally { release(); }
  });
});
