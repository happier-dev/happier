import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { WorkspaceSyncStatusV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
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
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
  const credentials = { token, encryption: null };
  let approval: ApprovalRequest | null = null;
  const serverHttpBaseUrl = 'https://conflict-cli.test';
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
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    expect(url).toBe(`${serverHttpBaseUrl}/v1/machines/controller`);
    return { status: 200, data: { machine: { id: 'controller', kind: 'persistent', storageMode: 'plain',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, active: true, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
  });
  const { executor } = createCliActionExecutorHarness({ ...credentials, credentials, sessionId: 'cli-global',
    serverId: 'home', serverIdentityId: 'srv_conflict-home', runtimeActionMachineId: 'controller',
    serverHttpBaseUrl, mode: 'plain', ctx: null }, {
    readActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }),
    approvalsCreate: async ({ request }) => { approval = request; return { artifactId }; },
    approvalsGet: async () => approval,
    approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
  });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  await handleActionsCommand(['invoke', actionId, '--machine-id', 'controller', '--input-json', JSON.stringify(input), '--json'], {
    readCredentialsFn: async () => credentials,
    createExecutorFn: ({ machineId }) => {
      expect(machineId).toBe('controller');
      return {
        execute: (id, actionInput, context) => executor.execute(id, actionInput, { ...context, authority: 'present_user' }),
        resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); },
      };
    },
  });
  expect(JSON.parse(output), output).toMatchObject({
    ok: true, data: { kind: 'approval_request_created', actionId, artifactId },
  });
  expect(dispatch).not.toHaveBeenCalled();

  const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
    { surface: 'ui', authority: 'present_user', serverId: 'home' });
  expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
