// Keep the real UI Account/Sync owners below their canonical native boundaries.
import '../../../../ui/sources/dev/vitestSetup';
import axios, { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, RPC_METHODS,
  SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
  SessionOwnerMetadataEnvelopeV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol';
import { SESSION_CONNECTED_SERVICE_AUTH_OPTIONS_SOURCE_ID, SessionConnectedServiceAuthSwitchRpcParamsSchema } from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';
import { ACTION_OPTIONS_RESOLVE_ACTION_ID_V1, SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { SESSION_CONFIG_OPTION_IDS_SOURCE_ID, SESSION_CONFIG_OPTION_VALUES_SOURCE_ID } from '@happier-dev/protocol/sessions/control/sessionConfigOptionV1';
import { parseSocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, createAccountTokenForTests } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture } from '../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '../../../../ui/sources/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '../../../../ui/sources/dev/testkit/cleanup/standardCleanup';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createSessionConfigOptionEnvironmentOwner, registerMachineSessionConfigOptionRpcHandlers } from '@/api/machine/rpcHandlers.sessionConfigOptions';
import { createRequesterSessionAccountContextCustody } from '@/daemon/sessionEncryption/requesterSessionAccountContextCustody';
import { createRequesterSessionRuntimeContextResolver, type RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { TrackedSession } from '@/daemon/types';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

vi.mock('socket.io-client', async importOriginal =>
  (await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('../../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

let daemonAnswer: (method: string, params: unknown, context: RpcHandlerContext) => unknown;
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
    const authorization = parseSocketRpcAuthorizationContext('authorization' in payload ? payload.authorization : undefined);
    try {
      return { ok: true, result: await daemonAnswer(payload.method, payload.params, {
        ...(authorization ? { authorization } : {}), signal: new AbortController().signal,
      }) };
    } catch (error) {
      const errorCode = readRpcErrorCode(error);
      if (!errorCode) throw error;
      return { ok: true, result: { errorCode, error: errorCode } };
    }
  });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await (await import('../../../../ui/sources/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const accountId = 'session-parity-account';
const sessionId = 'c123456789012345678901234';
const machineId = 'session-parity-machine';
const credentials = { token: createAccountTokenForTests(accountId), encryption: null } as const;
const controls = [SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1] as const;

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
  vi.spyOn(axios, 'patch').mockImplementation(async (url, body, config) => {
    const headers = new Headers(AxiosHeaders.from(config?.headers).toJSON() as Record<string, string>);
    const response = await homes.request(String(url), { method: 'PATCH', headers, body: JSON.stringify(body) });
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

function installConfigSession() {
  const metadata = { path: '/checkout', host: 'test', flavor: 'opencode', machineId,
    sessionModelsV1: { v: 1 as const, agentId: 'opencode', updatedAt: 1, currentModelId: 'vendor/model',
      availableModels: [{ id: 'vendor/model', name: 'Current model', modelOptions: [
        { id: 'enabled', name: 'Enabled', type: 'boolean' as const, currentValue: false },
      ] }] },
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
  return () => row;
}

describe('CLI current-Session control owners', () => {
  it('uses the Session Account for option choices and writes on a shared Machine', async () => {
    const readRow = installConfigSession();
    const custodian = { token: createAccountTokenForTests('machine-custodian'), encryption: null };
    const installationId = 'test-installation';
    const attribution = { serverId, accountId, machineId, installationId };
    // Retain the authenticated requester supplied by the Machine runtime. HTTP remains
    // the mocked boundary, and the actual resolver checks this Session and attribution.
    const requester = { bootstrap: { attribution, credentials, serverHttpBaseUrl: 'https://session-parity.test',
      getBoundSessionId: () => sessionId }, isCurrent: async () => true } as unknown as RequesterSessionRuntimeContext;
    const tracked = { happySessionId: sessionId, requesterSessionRuntimeContext: requester,
      requesterWorkAttributionV1: attribution } as TrackedSession;
    const trackedSessions = new Map([[sessionId, tracked]]);
    const custody = createRequesterSessionAccountContextCustody({ trackedSessions, serverId, machineId,
      externalActionAccountId: 'machine-custodian', isRetired: () => false,
      resolveRequesterSessionRuntimeContext: createRequesterSessionRuntimeContextResolver({
        trackedSessions, getCreateRuntime: () => null, recoverBootstrap: async () => null,
      }),
    });
    const handlers = new Map<string, RpcHandler>();
    registerMachineSessionConfigOptionRpcHandlers({
      withEnvironment: createSessionConfigOptionEnvironmentOwner({ machineId, serverId, credentials: custodian, ...custody }),
      rpcHandlerManager: { registerHandler: (method, handler) => handlers.set(method, handler as RpcHandler) },
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'machine-custodian',
        machineId, installationId, role: 'use', encryptionMode: 'plain' } };
    const read = handlers.get(RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_CHOICES)!;
    const write = handlers.get(RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_SET)!;
    const request = { sessionId, configId: 'effort', valueId: 'high' };
    expect(await read({ sessionId }, context)).toMatchObject({
      options: expect.arrayContaining([{ id: 'effort', label: 'Thinking', values: expect.arrayContaining([{ id: 'high', label: 'High' }]) }]),
    });
    expect(await write(request, context)).toEqual({ ...request, metadataVersion: readRow().metadataVersion });
    const reads = vi.mocked(axios.get).mock.calls
      .filter(([url]) => String(url).includes(`/v2/sessions/${sessionId}`))
      .map(([, config]) => AxiosHeaders.from(config?.headers).get('Authorization') === `Bearer ${credentials.token}`);
    const writes = vi.mocked(axios.patch).mock.calls
      .filter(([url]) => String(url).includes(`/v2/sessions/${sessionId}`))
      .map(([, , config]) => AxiosHeaders.from(config?.headers).get('Authorization') === `Bearer ${credentials.token}`);
    expect(writes.length).toBeGreaterThan(0);
    expect(reads.length).toBeGreaterThan(0);
    expect({ reads: reads.every(Boolean), writes: writes.every(Boolean) }).toEqual({ reads: true, writes: true });
  });

  it.each(['agent', 'mcp'] as const)('writes Session configuration and connected-account routing without an app on %s', async surface => {
    const readRow = installConfigSession();
    // The Socket transport is mocked. The receiving handlers, choice admission
    // and metadata tuple writer are real and there is no reverse-dispatch client.
    const daemonHandlers = new Map<string, RpcHandler>();
    registerMachineSessionConfigOptionRpcHandlers({
      withEnvironment: async (_sessionId, context, operation) => operation({ credentials, machineId, signal: context?.signal }),
      rpcHandlerManager: { registerHandler: (method, handler) => daemonHandlers.set(`${machineId}:${method}`, handler as RpcHandler) },
    });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_session_parity' } } });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl: 'https://session-parity.test',
      pluginActionExecutionOwner: 'current_process', serverIdentityId: 'srv_session_parity',
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features, provenance: 'authenticated' }),
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: storage.getState().settings }) });
    const context = { surface, authority: 'account_automation' as const, defaultSessionId: sessionId };
    const config = { sessionId, configId: 'effort', valueId: 'high' };
    const service = 'happier.agent.codex/openai-codex';
    const routing = { agentId: 'external-agent', selectedServiceId: service,
      bindings: { v: 2 as const, bindingsByServiceId: { [service]: { source: 'native' as const } } } };
    const auth = { sessionId, machineId, serverId, routing };
    const applied: unknown[] = [];
    daemonAnswer = (method, raw, received) => {
      const configHandler = daemonHandlers.get(method);
      if (configHandler) {
        return runWithServerHttpBaseUrl('https://session-parity.test', () => Promise.resolve(configHandler(raw, received)));
      }
      if (method === `${machineId}:${RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_OPTIONS}`) {
        expect(raw).toEqual({ sessionId });
        return { ok: true, options: [{ label: 'Native sign-in', routing }] };
      }
      expect(method).toBe(`${machineId}:${RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH}`);
      const input = SessionConnectedServiceAuthSwitchRpcParamsSchema.parse(raw);
      applied.push(input);
      return { ok: true, action: 'metadata_updated', materializedTargetByServiceId: { internal: '/private/runtime' },
        verificationByServiceId: { internal: { accountId: 'another-account' } } };
    };
    const readOptions = (fieldPath: 'configId' | 'valueId', optionsSourceId: string, draftInput: Record<string, string>) =>
      executor.execute(ACTION_OPTIONS_RESOLVE_ACTION_ID_V1, {
        actionId: SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, fieldPath, optionsSourceId, sessionId, draftInput,
      }, context);
    expect(await readOptions('configId', SESSION_CONFIG_OPTION_IDS_SOURCE_ID, {})).toMatchObject({
      ok: true, result: { options: [{ value: 'enabled', label: 'Enabled' }, { value: 'effort', label: 'Thinking' }] },
    });
    expect(await readOptions('valueId', SESSION_CONFIG_OPTION_VALUES_SOURCE_ID, { configId: 'effort' })).toMatchObject({
      ok: true, result: { options: [{ value: 'medium' }, { value: 'high' }, { value: null }] },
    });
    expect(await readOptions('valueId', SESSION_CONFIG_OPTION_VALUES_SOURCE_ID, { configId: 'enabled' })).toMatchObject({
      ok: true, result: { options: [{ value: 'false' }, { value: 'true' }, { value: null }] },
    });
    expect(await executor.execute(SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, config, context))
      .toEqual(expect.objectContaining({ ok: true, result: { ...config, metadataVersion: readRow().metadataVersion } }));
    const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(readRow().ownerMetadata);
    if (owner.t !== 'plain') throw new Error('Expected plain Account metadata');
    const visible = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(readRow().metadata), ownerMetadata: owner.v });
    expect(visible.acpConfigOptionOverridesV1).toMatchObject({ overrides: { effort: { value: 'high' } } });
    expect(await executor.execute(SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1, auth, context))
      .toEqual(expect.objectContaining({ ok: true, result: { ok: true, action: 'metadata_updated' } }));
    expect(applied).toEqual([expect.objectContaining({ sessionId, agentId: routing.agentId, bindings: routing.bindings })]);
    const acceptedVersion = readRow().metadataVersion;
    expect(await executor.execute(SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, { ...config, valueId: 'unadvertised' }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(readRow().metadataVersion).toBe(acceptedVersion);
    expect(await executor.execute(SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1, auth, context))
      .toEqual(expect.objectContaining({ ok: true, result: { ok: true, action: 'metadata_updated' } }));
    const options = await executor.execute(ACTION_OPTIONS_RESOLVE_ACTION_ID_V1, {
      actionId: SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1,
      fieldPath: 'routing',
      optionsSourceId: SESSION_CONNECTED_SERVICE_AUTH_OPTIONS_SOURCE_ID,
      sessionId,
      draftInput: { machineId },
    }, context);
    expect(options).toMatchObject({ ok: true, result: { options: [{ label: 'Native sign-in', value: routing }] } });
    expect(await executor.execute(SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, { ...config, valueId: null }, context))
      .toEqual(expect.objectContaining({ ok: true, result: {
        sessionId, configId: config.configId, valueId: null, metadataVersion: readRow().metadataVersion,
      } }));
    if (!options.ok) throw new Error('Expected eligible routing choices');
    const published = options.result as { options: Array<{ value: unknown }> };
    expect(await executor.execute(SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1, { ...auth, routing: published.options[0].value }, context))
      .toEqual(expect.objectContaining({ ok: true, result: { ok: true, action: 'metadata_updated' } }));
    expect(applied).toHaveLength(3);
  });
});
