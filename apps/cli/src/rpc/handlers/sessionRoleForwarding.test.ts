import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { callSocketRpc } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { describe, expect, it } from 'vitest';
import { createActionExecutor, createRoleSourceReaderV1, readSessionRoleIdV1, RoleActionInputSchemasV1, RoleActionOutputSchemasV1, type ActionExecutorDeps } from '@happier-dev/protocol';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createRoleActionExecutor } from '@/session/actions/roleActions';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { createSessionReadBatchResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

describe('Session role RPC provenance', () => {
  it('uses one registered Role writer for a transported UI edit and CLI edit, with an idle-runtime refusal', async () => {
    let metadata = createTestMetadata();
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const rpc = new RpcHandlerManager({ scopePrefix: 'child', encryptionMode: 'plain', logger: () => {} });
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'child', readSessionMetadata: () => metadata,
      readSettingsOverrides: () => ({ status: 'ready', overrides: {} }),
      readRoleSources: createRoleSourceReaderV1({}),
      stageSessionStateMutation: async mutation => {
        queued.push(mutation);
        metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation);
      },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), roleActionExecute });
    registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['session.role.set'], actionExecutor: executor });
    const http = createServer();
    const server = new Server(http);
    server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, async (payload: unknown, acknowledge) => {
      // Socket.IO's untyped callback carries the canonical RPC client's wire payload.
      const request = payload as SocketRpcRequestPayload;
      // This test Home authenticates a present user at the actual network boundary.
      acknowledge({ ok: true, result: await rpc.handleRequest({ method: request.method, params: request.params,
        callerAuthority: 'present_user' }) });
    }));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Session RPC fixture has no listening address');
    const client = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], autoConnect: false });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve); client.once('connect_error', reject); client.connect();
      });
      const input = RoleActionInputSchemasV1['session.role.set'].parse({ sessionId: 'child', roleId: 'builder' });
      const output = await callSocketRpc({ socket: client, target: { kind: 'session', id: 'child' },
        method: 'session.role.set', params: input, content: { mode: 'plain' } });
      expect(RoleActionOutputSchemasV1['session.role.set'].parse(output)).toEqual({ updated: true });
      expect(readSessionRoleIdV1(metadata)).toBe('builder');
      expect(queued).toMatchObject([{ fieldId: 'intent.role', deliveryClass: 'durable_required',
        op: { kind: 'set', value: 'builder' } }]);
      const cli = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        roleActionExecute: createRoleActionExecutor({ sessionId: 'cli-global', forwardSessionRoleAction: async request =>
          callSocketRpc({ socket: client, target: { kind: 'session', id: 'child' }, method: request.actionId,
            params: request.input, content: { mode: 'plain' } }) }),
      });
      expect(await cli.execute('session.role.set', input, { surface: 'cli', authority: 'present_user' }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(queued).toHaveLength(2);
      expect(queued[1]).toMatchObject({ fieldId: queued[0].fieldId, deliveryClass: queued[0].deliveryClass, op: queued[0].op });
      const roleBeforeToggle = readSessionRolesV1(metadata);
      const toggle = { sessionId: 'child', answersWorkerQuestions: false };
      expect(await cli.execute('session.role.set', toggle, { surface: 'cli', authority: 'present_user' }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(readSessionRolesV1(metadata)).toEqual({ ...roleBeforeToggle, answersWorkerQuestions: false });
      expect(await callSocketRpc({ socket: client, target: { kind: 'session', id: 'child' },
        method: 'session.role.set', params: { ...toggle, answersWorkerQuestions: true }, content: { mode: 'plain' } }))
        .toEqual({ updated: true });
      expect(readSessionRolesV1(metadata)).toEqual({ ...roleBeforeToggle, answersWorkerQuestions: true });
      // A tightening Role on an idle/unbound runtime must refuse without adding a mutation.
      const beforeRefusal = queued.length;
      expect(await cli.execute('session.role.set', { sessionId: 'child', roleId: 'orchestrator' },
        { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'role_policy_unenforceable' });
      expect(queued).toHaveLength(beforeRefusal);
      expect(readSessionRoleIdV1(metadata)).toBe('builder');
    } finally {
      client.disconnect();
      await rpc.waitForIdle();
      await server.close();
    }
  });

  it('admits the original Session caller and refuses the next edit after subtree membership changes', async () => {
    let metadata = createTestMetadata();
    let inSubtree = true;
    const rpc = new RpcHandlerManager({ scopePrefix: 'child', encryptionMode: 'plain', logger: () => {} });
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'child', readSessionMetadata: () => metadata,
      readSettingsOverrides: () => ({ status: 'ready', overrides: {} }),
      readRoleSources: createRoleSourceReaderV1({}),
      stageSessionStateMutation: async (mutation) => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); } });
    const deps = { roleActionExecute,
      resolveAgentStartContext: async (context) => resolveCliAgentStartContextV1({ sessionId: 'lead', machineId: 'source-machine',
        directory: '/repo', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        metadata: createTestMetadata(), starterDepth: 2, turnDepth: 3, settings: null,
        // A notes edit needs caller scope, not an invented native baseline.
        roles: {},
        accountRoleOverrides: { status: 'ready', overrides: {} },
        roleSourceInventory: await createRoleSourceReaderV1({})(),
        callerPermissionMode: context.callerPermissionMode ?? null }),
      sessionRead: async request => {
        expect(request.underSessionId).toBe('lead');
        return createSessionReadBatchResponseFixture({
          request: { sessionIds: request.sessionIds, underSessionId: request.underSessionId, includeTurns: false },
          sessions: inSubtree ? [createSessionRecordFixture({ id: 'child', encryptionMode: 'plain',
            metadata: JSON.stringify(metadata) })] : [],
        });
      },
    } satisfies Pick<ActionExecutorDeps, 'roleActionExecute' | 'resolveAgentStartContext' | 'sessionRead'>;
    registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['session.notes.set'],
      actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
    const request = { method: 'child:session.notes.set', params: { sessionId: 'child', notes: 'Copied notes' },
      callerAuthority: 'account_automation' as const, sessionActionOrigin: { v: 1 as const,
        caller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 2, turnDepth: 3 },
        sourceTurnId: 'original-turn', callerPermissionMode: 'default' as const, requestId: 'original-request',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const } } };
    expect(await rpc.handleRequest(request)).toEqual({ updated: true });
    expect(metadata).toMatchObject({ work: { sessionRolesV1: { notes: 'Copied notes' } } });
    inSubtree = false;
    expect(await rpc.handleRequest({ ...request, params: { ...request.params, notes: 'After reparent' } }))
      .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(metadata).toMatchObject({ work: { sessionRolesV1: { notes: 'Copied notes' } } });
  });
  it('refuses an older Home dropping Session provenance but preserves authenticated present-user edits', async () => {
    let metadata = createTestMetadata();
    const rpc = new RpcHandlerManager({ scopePrefix: 'child', encryptionMode: 'plain', logger: () => {} });
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'child', readSessionMetadata: () => metadata,
      readSettingsOverrides: () => ({ status: 'ready', overrides: {} }),
      readRoleSources: createRoleSourceReaderV1({}),
      stageSessionStateMutation: async (mutation) => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); } });
    // Only the reachable role effect and storage boundary are installed. The
    // real Action dispatcher, transport binding and mutation owner are retained.
    const deps = { roleActionExecute } satisfies Pick<ActionExecutorDeps, 'roleActionExecute'>;
    registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['session.notes.set'],
      actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
    const request = { method: 'child:session.notes.set', params: { sessionId: 'child', notes: 'Copied notes' } };
    expect(await rpc.handleRequest(request)).toMatchObject({ ok: false, errorCode: 'role_rpc_origin_unavailable' });
    expect(metadata).not.toMatchObject({ work: { sessionRolesV1: { notes: 'Copied notes' } } });
    expect(await rpc.handleRequest({ ...request, callerAuthority: 'present_user' })).toEqual({ updated: true });
    expect(metadata).toMatchObject({ work: { sessionRolesV1: { notes: 'Copied notes' } } });
  });
});
