import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, SessionSpawnNewInputV2Schema, accountSettingsParse } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { io } from 'socket.io-client';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createApiSessionSocketStub, bindApiSessionSocketMock } from '@/testkit/backends/apiSessionSocketHarness';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

it.each([
  { role: 'use', installed: true, outdated: false, acquireAllowed: false, refusal: null },
  { role: 'use', installed: false, outdated: false, acquireAllowed: false, refusal: 'agent_cli_missing' },
  { role: 'use', installed: true, outdated: true, acquireAllowed: false, refusal: null },
  { role: 'manage', installed: false, outdated: false, acquireAllowed: true, refusal: null },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: null },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: null, terminalFailed: true },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: null, updateInUse: true },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: null, updatePending: true },
  { role: 'manage', installed: false, outdated: false, acquireAllowed: true, refusal: 'agent_cli_not_ready', terminalFailed: true },
  { role: 'manage', installed: true, outdated: true, acquireAllowed: true, refusal: 'agent_cli_not_ready', terminalFailed: true, dependencyMissing: true },
] as const)('admits Agent readiness before Session birth ($role, installed=$installed, outdated=$outdated)', async testCase => {
  const { installed, outdated, acquireAllowed, refusal } = testCase;
  const terminalFailed = 'terminalFailed' in testCase && testCase.terminalFailed;
  const updateInUse = 'updateInUse' in testCase && testCase.updateInUse;
  const updatePending = 'updatePending' in testCase && testCase.updatePending;
  const dependencyMissing = 'dependencyMissing' in testCase && testCase.dependencyMissing;
  const accountId = 'requester';
  const machineId = 'machine-1';
  const sessionId = 'readiness-session';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null };
  const events: string[] = [];
  let bornSession: Record<string, unknown> | undefined;
  let machineBound = false;
  const facts = { installed, version: installed ? '1.2.3' : null, latestVersion: '1.2.4',
    update: { supported: outdated, command: null },
    signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
    install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null },
    dependencies: dependencyMissing ? [{ key: 'runtime', installed: false, version: null }] : [] };
  const content = { mode: 'plain' as const };
  bindApiSessionSocketMock(vi.mocked(io), createApiSessionSocketStub({ emitWithAck: async (event, raw) => {
    if (event !== SOCKET_RPC_EVENTS.CALL || !raw || typeof raw !== 'object'
      || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Unexpected RPC');
    const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
    const method = raw.method.slice(raw.method.indexOf(':') + 1);
    // Socket.IO is the genuine Home boundary. Real Home Use/Manage admission
    // is independently exercised in sessionAgentReadiness.sqlite.integration.spec.ts;
    // these granted/refused network outcomes exercise the Session owner response.
    if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START && !acquireAllowed) {
      return { ok: false, error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN };
    }
    let result: unknown;
    if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
      result = { ok: true, directory: '/remote/project', directoryKind: 'path', directoryCreationRequired: false, checkout: null };
    } else if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      events.push('inventory');
      result = { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
        codex: { id: 'codex', title: 'Codex', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
      } } };
    } else if (method === RPC_METHODS.CAPABILITIES_DETECT) {
      result = { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: facts } } };
    } else if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START) {
      events.push(outdated ? 'update' : 'install');
      result = updateInUse ? { ok: false, errorCode: 'in_use', error: 'The installed Agent is in use' } : { ok: true, jobId: 'acquisition-job' };
    } else if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ) {
      expect(decoded.params).toMatchObject({ jobId: 'acquisition-job', waitForTerminal: !(installed && !dependencyMissing) });
      expect(events).not.toContain('birth');
      events.push('terminal');
      result = { ok: true, steps: [], progress: [], events: [], nextCursor: 0, done: !updatePending,
        ...(updatePending ? {} : { outcome: terminalFailed ? { kind: 'failed', code: 'install_failed', stepId: 'install', message: 'Installer failed' }
          : { kind: 'succeeded', version: '1.2.4' } }) };
    } else throw new Error(`Unexpected RPC ${method}`);
    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
  } }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine: { id: machineId, active: true,
      installationId: 'installation-1', kind: 'persistent', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      revokedAt: null, replacedByMachineId: null } } };
    if (path === `/v1/access-keys/${sessionId}/${machineId}`) return { status: 200,
      data: { accessKey: machineBound ? { data: 'bound-key' } : null } };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: bornSession } };
    throw new Error(`Unexpected Home read ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: bornSession ? [bornSession] : [] } };
    if (path === '/v1/sessions') {
      events.push('birth');
      if (!raw || typeof raw !== 'object') throw new Error('Missing birth body');
      const ownerMetadata = SessionOwnerMetadataEnvelopeV1Schema.parse(Reflect.get(raw, 'ownerMetadata'));
      const shared = Reflect.get(raw, 'sharedMetadata');
      if (!shared || typeof shared !== 'object') throw new Error('Missing shared metadata');
      bornSession = { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        archivedAt: null, metadataVersion: 1, metadataLayoutVersion: 1,
        metadata: Reflect.get(shared, 'ciphertext'), ownerMetadata, encryptionMode: 'plain', agentState: null,
        agentStateVersion: 0, dataEncryptionKey: null, share: null };
      return { status: 200, data: { created: true, session: bornSession } };
    }
    if (path === `/v1/access-keys/${sessionId}/${machineId}`) {
      machineBound = true;
      return { status: 200, data: { success: true, accessKey: { data: Reflect.get(raw as object, 'data') } } };
    }
    throw new Error(`Unexpected Home write ${path}`);
  });
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url).endsWith('/v1/account/profile')) return Response.json({ id: accountId });
    if (String(url).endsWith('/v1/features')) return Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }));
    throw new Error(`Unexpected fetch ${url}`);
  }));
  const executor = createCliActionExecutor({ credentials, token, sessionId: '', mode: 'plain', ctx: null,
    serverId: 'home-a', serverIdentityId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ memoryUpkeepInNewBots: false,
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.agents.install': ['cli'] } },
    }) }),
    sessionSpawnDirectTargetTransport: { machineId, prepare: async () => ({ ok: true, directory: '/remote/project',
      directoryKind: 'path', directoryCreationRequired: false, checkout: null }), spawnedSession: {
      // The native process boundary performs birth and launch together.
      spawn: async () => { events.push('birth', 'spawn'); return { type: 'success', sessionId,
        sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } }; },
      resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
    } },
  });
  const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'readiness-birth',
    executionTarget: { serverId: 'home-a', machineId }, directory: { kind: 'path', path: '/remote/project' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false });
  const result = await executor.execute('session.spawn_new', input, { surface: 'cli', authority: 'present_user',
    actionCaller: { kind: 'host' }, serverId: 'home-a', bypassApprovals: true });
  if (refusal) {
    expect(result).toMatchObject({ ok: true, result: { type: 'error', code: refusal, agentId: 'codex', retryable: false } });
    expect(events).toEqual(terminalFailed ? ['inventory', outdated ? 'update' : 'install', 'terminal'] : ['inventory']);
  } else {
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
    if (installed && outdated && (!acquireAllowed || terminalFailed || updateInUse || updatePending)) {
      expect(result).toMatchObject({ result: { agentUpdate: { agentId: 'codex', status: terminalFailed ? 'failed' : 'pending' } } });
    }
    expect(events).toEqual(['inventory', ...(!installed || outdated && acquireAllowed
      ? [outdated ? 'update' : 'install', ...(updateInUse ? [] : ['terminal'])] : []), 'birth', 'spawn']);
  }
});
