import { once } from 'node:events';
import { createServer } from 'node:http';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { WorkspaceSyncStatusV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { reloadConfiguration } from '@/configuration';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { handleActionsCommand } from './actions';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
// Socket.IO and HTTP are the boundaries; CLI parsing, catalog, admission,
// exact-Machine routing and strict output validation execute unchanged.
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

it('executes Sync lifecycle from the CLI through the shared Action owner and exact controller', async () => {
  const status = WorkspaceSyncStatusV1Schema.parse({ relationshipId: 'copy-link', controllerMachineId: 'controller',
    state: 'watching', alphaPath: '/source', betaPath: '/copy', mode: 'keep_both_in_sync',
    endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: 1 });
  const cases = [
    { actionId: 'workspace.sync.relationship.disable', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE,
      result: { v: 1, relationshipId: 'copy-link', enabled: false } },
    { actionId: 'workspace.sync.relationship.enable', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME,
      result: { v: 1, relationshipId: 'copy-link', enabled: true } },
    { actionId: 'workspace.sync.relationship.flush', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH,
      result: { v: 1, relationshipId: 'copy-link', status } },
    { actionId: 'workspace.sync.relationship.terminate', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE,
      result: { v: 1, relationshipId: 'copy-link', terminated: true } },
  ] as const;
  const serverId = 'sync-cli-home';
  const serverHttpBaseUrl = 'https://sync-cli.test';
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
  const credentials = { token, encryption: null };
  const input = { controllerMachineId: 'controller', relationshipId: 'copy-link' };
  const requests: unknown[] = [];
  io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck(event, raw) {
    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
    requests.push(raw);
    return { ok: true, result: { ok: true, status } };
  } }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    expect(url).toBe(`${serverHttpBaseUrl}/v1/machines/controller`);
    return { status: 200, data: { machine: { id: 'controller', kind: 'persistent', storageMode: 'plain',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, active: true, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
  });
  let enabled = true;
  const settings = { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
    actions: enabled ? {} : { 'workspace.sync.relationship.flush': { enabled: false } },
    approvalWaivedSurfaces: Object.fromEntries(cases.map(({ actionId }) => [actionId, ['cli']])) }), getAccountSettings: () => null };
  const executor = createCliActionExecutor({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
    serverId, serverHttpBaseUrl, actionsSettingsProvider: settings, pluginActionExecutionOwner: 'current_process' });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  for (const { actionId, method, result } of cases) {
    output = '';
    await handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(input), '--json'], {
      readCredentialsFn: async () => credentials,
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async sessionId => ({ ok: true as const, sessionId }) }),
    });
    expect(JSON.parse(output), output).toMatchObject({ ok: true, kind: 'actions_invoke', data: result });
    expect(requests.at(-1)).toMatchObject({ method: `controller:${method}`, params: { relationshipId: input.relationshipId } });
  }
  enabled = false;
  const before = requests.length;
  output = '';
  await handleActionsCommand(['invoke', 'workspace.sync.relationship.flush', '--input-json', JSON.stringify(input), '--json'], {
    readCredentialsFn: async () => credentials,
    createExecutorFn: () => ({ ...executor, resolveSessionTarget: async sessionId => ({ ok: true as const, sessionId }) }),
  });
  expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'action_disabled' } });
  expect(requests).toHaveLength(before);
});

it('requests CLI conflict resolution and applies the reviewed input only after approval', async () => {
  const actionId = 'workspace.sync.conflict.resolve';
  const artifactId = 'conflict-approval';
  const input = {
    controllerMachineId: 'controller', hubWorkspaceRefId: 'hub', path: 'conflicted.txt',
    source: { workspaceRefId: 'hub', expected: { kind: 'file', digest: 'a'.repeat(40), executable: false, size: 1 } },
    targets: [{ workspaceRefId: 'spoke', expected: { kind: 'file', digest: 'b'.repeat(40), executable: false, size: 1 } }],
    relationshipIds: ['copy-link'], strategy: 'use_source',
  };
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1, session: 'terminal-enrollment',
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  let approval: ApprovalRequest | null = null;
  const resolved = { endpoints: [{ workspaceRefId: 'spoke', status: 'applied' as const }] };
  const dispatch = vi.fn((event: string, request: unknown) => {
    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
    expect(request).toMatchObject({
      method: `controller:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE}`,
      params: { actionReceiptId: artifactId, actionInput: input },
    });
    return { ok: true, result: resolved };
  });
  io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: dispatch }));

  const received: unknown[] = [];
  let endpoint = '';
  let executor!: ReturnType<typeof createCliActionExecutorHarness>['executor'];
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/features/authenticated') {
        response.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_conflict-home' } } }));
        return;
      }
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify(createAccountEncryptionCurrentnessFixture({ mode: 'plain' })));
        return;
      }
      if (request.url === '/v1/account/encryption') {
        response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        return;
      }
      if (request.url === '/v2/account/settings') {
        response.end(JSON.stringify({
          content: {
            t: 'plain',
            v: { actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } } },
          },
          version: 1,
        }));
        return;
      }
      if (request.url === '/v1/machines') {
        response.end(JSON.stringify([
          { id: 'controller', kind: 'persistent', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            active: true, activeAt: Date.now(), revokedAt: null, replacedByMachineId: null,
            access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } },
          { id: 'other-machine', kind: 'persistent', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            active: true, activeAt: Date.now(), revokedAt: null, replacedByMachineId: null,
            access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } },
        ]));
        return;
      }
      if (request.url === '/v1/machines/controller') {
        response.end(JSON.stringify({ machine: { id: 'controller', kind: 'persistent', storageMode: 'plain',
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, active: true, revokedAt: null, replacedByMachineId: null,
          access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } }));
        return;
      }
      if (request.url?.startsWith('/v1/actions/')) {
        const routedActionId = decodeURIComponent(request.url.slice('/v1/actions/'.length));
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const parsed = JSON.parse(body) as { requestId: string; input: unknown; target?: { kind: 'machine'; machineId: string } };
        received.push({ actionId: routedActionId, ...parsed });
        const executed = await executor.execute(routedActionId as typeof actionId, parsed.input, {
          surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_conflict-home',
          ...(parsed.target ? { externalActionTarget: parsed.target } : {}),
        });
        response.end(JSON.stringify({ v: 1, actionId: routedActionId, requestId: parsed.requestId, execution: executed }));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: `Unexpected route ${request.url}` }));
    })().catch(error => {
      response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP fixture');
  endpoint = `http://127.0.0.1:${address.port}`;
  executor = createCliActionExecutorHarness({ ...credentials, credentials, sessionId: 'cli-global',
    serverId: 'home', serverIdentityId: 'srv_conflict-home', runtimeActionMachineId: 'controller',
    serverHttpBaseUrl: endpoint, mode: 'plain', ctx: null }, {
    readActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }),
    approvalsCreate: async ({ request }) => { approval = request; return { artifactId }; },
    approvalsGet: async () => approval,
    approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
  }).executor;

  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TOKEN']);
  try {
    await withTempDir('happier-conflict-cli-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: endpoint, HAPPIER_WEBAPP_URL: endpoint, HAPPIER_TOKEN: undefined });
      reloadConfiguration();
      const profile = { id: 'home', name: 'Conflict Home', serverUrl: endpoint, webappUrl: endpoint,
        createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
        homeConnectionDescriptor: { v: 1 as const, homeServerIdentityId: 'srv_conflict-home', canonicalServerUrl: endpoint,
          revision: 1, endpoints: [{ kind: 'https' as const, url: endpoint }] } };
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
        output += String(chunk);
        const callback = args.find(argument => typeof argument === 'function');
        if (typeof callback === 'function') callback();
        return true;
      });
      const invoke = async (
        extraFlags: readonly string[],
        useCredentials: typeof credentials | { token: string; encryption: null; credentialProvenance: 'api_token' } = credentials,
      ) => {
        output = '';
        process.exitCode = undefined;
        await handleActionsCommand(['invoke', actionId, ...extraFlags, '--server-id', profile.id, '--input-json', JSON.stringify(input), '--json'], {
          readCredentialsFn: async () => useCredentials,
          readCredentialsForServerIdFn: async () => useCredentials,
          getServerProfileFn: async () => profile,
          createExecutorFn: createCliActionExecutorFromCredentials,
        });
        return JSON.parse(output) as unknown;
      };

      // Both without --machine-id (derived from input.controllerMachineId) and with --machine-id must route cleanly to controllerMachineId.
      // Exercising the external-action placement path with api_token provenance directly catches executionPlacement: 'session' (target_required).
      const apiTokenCredentials = {
        token: `hap_v1_11111111-1111-4111-8111-111111111111_${'a'.repeat(43)}`,
        encryption: null,
        credentialProvenance: 'api_token' as const,
      };
      const withoutFlag = await invoke([], apiTokenCredentials);
      expect(withoutFlag, JSON.stringify(withoutFlag)).toMatchObject({
        ok: true, data: { kind: 'approval_request_created', actionId, artifactId },
      });
      const withFlag = await invoke(['--machine-id', 'controller'], apiTokenCredentials);
      expect(withFlag, JSON.stringify(withFlag)).toMatchObject({
        ok: true, data: { kind: 'approval_request_created', actionId, artifactId },
      });
      expect(received).toEqual([
        expect.objectContaining({ actionId, input, target: { kind: 'machine', machineId: 'controller' } }),
        expect.objectContaining({ actionId, input, target: { kind: 'machine', machineId: 'controller' } }),
      ]);
      expect(dispatch).not.toHaveBeenCalled();

      const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
        { surface: 'ui', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_conflict-home' });
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  } finally {
    env.restore();
    reloadConfiguration();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
