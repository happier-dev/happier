import { describe, expect, it } from 'vitest';
import { BUILT_IN_ROLES_V1, readSessionWorkspaceWritesV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { registerSessionRoleConfigurationHandler } from './sessionRoleConfiguration';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';

describe('session role configuration RPC', () => {
  it('refuses an older Home dropping the Session origin even for a non-relaxing report copy', async () => {
    let metadata = createTestMetadata();
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => metadata,
      stageSessionStateMutation: async (mutation) => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); } });
    expect(await handlers.get(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)!({ sessionId: 'child',
      configuration: { inheritedFrom: 'lead', overrides: {}, sessionRoles: {}, notes: 'Unproved copy' } },
    { signal: new AbortController().signal, callerAuthority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'role_rpc_origin_unavailable' });
    expect(metadata).not.toMatchObject({ work: { sessionRolesV1: { notes: 'Unproved copy' } } });
  });
  it('copies for the original Session caller using current subtree, report relation and source role policy', async () => {
    let source: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: 'Lead' } } };
    let target: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: 'Child' } } };
    let currentLead = 'lead';
    let inSubtree = true;
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => target,
      // Storage/transport snapshots are the boundary; the real caller resolver,
      // subtree parser, admission policy and registered mutation owner run below.
      resolveAgentStartContext: async (context) => resolveCliAgentStartContextV1({
        sessionId: 'lead', machineId: 'source-machine', directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        metadata: source, starterDepth: 2, turnDepth: 3, callerPermissionMode: context.callerPermissionMode ?? null, settings: null,
      }),
      sessionList: async ({ query }) => ({ queryVersion: 1, sessions: inSubtree && query?.storage === 'active' ? [{
        id: 'child', createdAt: 1, updatedAt: 1, active: true, activeAt: 1, encryption: null,
      }] : [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }),
      readCurrentReportLead: async () => currentLead,
      readCallerWorkspaceWrites: async () => readSessionWorkspaceWritesV1(source) ?? null,
      stageSessionStateMutation: async (mutation) => {
        expect(mutation.source).toBe('runtime');
        target = applyRegisteredSessionStateFieldMutationToMetadata(target, mutation);
      },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)!;
    const request = { sessionId: 'child', configuration: { inheritedFrom: 'lead', overrides: {}, sessionRoles: {}, notes: 'Copied' } };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'lead', starterDepth: 2, turnDepth: 3 },
        callerPermissionMode: 'default', sourceTurnId: 'original-turn', requestId: 'copy-request', workspaceWrites: 'allow' } };
    expect(await handler(request, context)).toEqual({ updated: true });
    expect(target).toMatchObject({ work: { sessionRolesV1: { roleId: 'builder', notes: 'Copied', inheritedFrom: 'lead' } } });
    currentLead = 'other';
    expect(await handler({ ...request, configuration: { ...request.configuration, notes: 'Reparented' } }, context))
      .toMatchObject({ ok: false, errorCode: 'session_target_not_led' });
    currentLead = 'lead'; inSubtree = false;
    expect(await handler(request, context)).toMatchObject({ ok: false, errorCode: 'session_target_not_led' });
    inSubtree = true;
    source = { ...source, work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: 'Lead' } } };
    expect(await handler({ ...request, configuration: { ...request.configuration, notes: 'Relaxed' } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_policy_denied' });
    expect(target).toMatchObject({ work: { sessionRolesV1: { notes: 'Copied' } } });
  });
  it('rejects report copies when the authenticated caller cannot reach the target or allows forbidden writes', async () => {
    let metadata = createTestMetadata();
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => metadata,
      stageSessionStateMutation: async (mutation) => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)!;
    const request = { sessionId: 'child', configuration: { inheritedFrom: 'lead', overrides: {}, sessionRoles: {}, notes: 'Forged copy' } };
    const sessionActionOrigin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 2, turnDepth: 3 },
      callerPermissionMode: 'default' as const, sourceTurnId: 'original-turn', requestId: 'copy-request', workspaceWrites: 'deny' as const };
    expect(await handler(request, { signal: new AbortController().signal, callerAuthority: 'account_automation', sessionActionOrigin }))
      .toMatchObject({ ok: false, errorCode: 'session_target_not_led' });
    expect(metadata).not.toMatchObject({ work: { sessionRolesV1: { notes: 'Forged copy' } } });
  });
  it('does not relax native policy before a remote user configuration is durably accepted', async () => {
    let nativePolicy: 'allow' | 'deny' = 'deny';
    const metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { roleId: 'builder',
      overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } }, sessionRoles: {}, notes: '' } } };
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => metadata,
      prepareWorkspaceWritesPolicy: async (policy) => { nativePolicy = policy; return { ok: true }; },
      stageSessionStateMutation: async () => { throw new Error('Durable enqueue failed'); },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)!;
    await expect(handler({ sessionId: 'child', configuration: { overrides: {}, sessionRoles: {}, notes: 'Copied' } },
      { signal: new AbortController().signal, callerAuthority: 'present_user' })).rejects.toThrow('Durable enqueue failed');
    expect(nativePolicy).toBe('deny');
    expect(metadata.work).toMatchObject({ sessionRolesV1: { overrides: { builder: { workspaceWrites: 'deny' } } } });
  });

  it('uses the registered outbox, preserves current role, and rejects unproved or automated relaxation', async () => {
    let metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { roleId: 'builder', overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } },
      sessionRoles: {}, notes: 'Original' } } };
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => metadata,
      prepareWorkspaceWritesPolicy: async () => ({ ok: true }),
      stageSessionStateMutation: async (mutation) => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); } });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)!;
    const request = { sessionId: 'child', configuration: { inheritedFrom: 'lead', overrides: {},
      sessionRoles: { builder: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder' } }, notes: 'Copied' } };
    expect(await handler(request)).toMatchObject({ ok: false, errorCode: 'permission_denied' });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
      localActionContext: { authority: 'account_automation', surface: 'agent' } };
    expect(await handler(request, context)).toMatchObject({ ok: false, errorCode: 'role_policy_denied' });
    expect(metadata.work).toMatchObject({ sessionRolesV1: { notes: 'Original' } });
    expect(await handler(request, { ...context, callerAuthority: 'present_user' })).toEqual({ updated: true });
    expect(metadata.work).toMatchObject({ sessionRolesV1: { roleId: 'builder', inheritedFrom: 'lead', notes: 'Copied', overrides: {} } });
    expect(await handler({ ...request, sessionId: 'other' }, { ...context, callerAuthority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
  });
});
