import { describe, expect, it } from 'vitest';
import { createActionExecutor, createRoleSourceReaderV1, type ActionExecutorDeps } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createRoleActionExecutor } from '@/session/actions/roleActions';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';

describe('Session role RPC provenance', () => {
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
        accountRoleOverrides: { status: 'ready', overrides: {} },
        roleSourceInventory: await createRoleSourceReaderV1({})(),
        callerPermissionMode: context.callerPermissionMode ?? null }),
      sessionList: async () => ({ queryVersion: 1, sessions: inSubtree ? [{ id: 'child', createdAt: 1, updatedAt: 1,
        active: true, activeAt: 1, encryption: null }] : [], nextCursor: null, hasNext: false,
        attentionNextCursor: null, attentionHasNext: false }),
    } satisfies Pick<ActionExecutorDeps, 'roleActionExecute' | 'resolveAgentStartContext' | 'sessionList'>;
    registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['session.notes.set'],
      actionExecutor: createActionExecutor({ ...createCliActionDeps({ token: 'token', sessionId: 'child', mode: 'plain', ctx: null }), ...deps }) });
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
      actionExecutor: createActionExecutor({ ...createCliActionDeps({ token: 'token', sessionId: 'child', mode: 'plain', ctx: null }), ...deps }) });
    const request = { method: 'child:session.notes.set', params: { sessionId: 'child', notes: 'Copied notes' } };
    expect(await rpc.handleRequest(request)).toMatchObject({ ok: false, errorCode: 'role_rpc_origin_unavailable' });
    expect(metadata).not.toMatchObject({ work: { sessionRolesV1: { notes: 'Copied notes' } } });
    expect(await rpc.handleRequest({ ...request, callerAuthority: 'present_user' })).toEqual({ updated: true });
    expect(metadata).toMatchObject({ work: { sessionRolesV1: { notes: 'Copied notes' } } });
  });
});
