import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountSettingsParse, BUILT_IN_ROLES_V1, createRoleSourceReaderV1, readSessionWorkspaceWritesV1 } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { registerSessionRoleConfigurationHandler as registerOwnerSessionRoleConfigurationHandler } from './sessionRoleConfiguration';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { writeSessionRoleIdV1ToMetadata, writeSessionRoleConfigurationV1ToMetadata } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

function registerSessionRoleConfigurationHandler(params: Parameters<typeof registerOwnerSessionRoleConfigurationHandler>[0]) {
  registerOwnerSessionRoleConfigurationHandler({ readSettingsOverrides: () => {
    const snapshot = getActiveAccountSettingsSnapshot();
    return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot) : { status: 'unavailable', reason: 'source-unavailable' };
  }, ...params });
}

describe('session role configuration RPC', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ scopeKey: 'roles-test', source: 'network', settingsVersion: 1, settings: accountSettingsParse({}),
      rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  });
  afterEach(() => resetActiveAccountSettingsSnapshotForTests());
  it('applies complete report snapshots without waiting on unrelated Artifact inventory', async () => {
    let metadata = createTestMetadata({ work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: 'Before copy' } } });
    const handlers = new Map<string, RpcHandler>();
    // The external Artifact store is unavailable; built-in and inherited policy
    // still have complete local authority at the registered recipient owner.
    const sources = createRoleSourceReaderV1({ artifactStore: {
      list: async () => { throw new Error('Unrelated Artifact inventory is unavailable'); },
      read: async () => null,
    } });
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => metadata, readRoleSources: sources,
      stageSessionStateMutation: async mutation => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); } });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)!;
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user' };
    const configuration = { inheritedFrom: 'lead', overrides: {}, sessionRoles: {
      builder: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder' },
      inherited: { ...BUILT_IN_ROLES_V1.builder, roleId: 'inherited', name: 'Release checks' },
    }, notes: 'Copied release notes', answersWorkerQuestions: false };
    expect(await handler({ sessionId: 'child', configuration }, context)).toEqual({ updated: true });
    expect(metadata.work?.sessionRolesV1).toMatchObject({ roleId: 'builder', ...configuration });
    metadata = writeSessionRoleIdV1ToMetadata(metadata, 'inherited');
    const { answersWorkerQuestions: _answersWorkerQuestions, ...rolesOnlyConfiguration } = configuration;
    expect(await handler({ sessionId: 'child', configuration: { ...rolesOnlyConfiguration, notes: 'Second copy' } }, context))
      .toEqual({ updated: true });
    expect(metadata.work?.sessionRolesV1).toMatchObject({ roleId: 'inherited', notes: 'Second copy', answersWorkerQuestions: false });
    metadata = writeSessionRoleIdV1ToMetadata(metadata, 'external-role');
    await expect(handler({ sessionId: 'child', configuration: { ...configuration, notes: 'Unproved external policy' } }, context))
      .rejects.toThrow('Unrelated Artifact inventory is unavailable');
    expect(metadata.work?.sessionRolesV1?.notes).toBe('Second copy');
  });
  it('rejects signed Workflow Role authority from another Account', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settingsVersion: 1, settings: accountSettingsParse({}),
      rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'home', machineId: 'run-machine', installationId: 'installed', actionId: 'session.role.set',
      requestId: 'role-write', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'session', sessionId: 'lead' },
      workflowActionOrigin: { runId: 'run', requestId: 'role-write', sessionAuthority: {
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, runDepth: 4,
        runOriginSessionId: 'lead', directory: '/repo', workspaceWrites: 'allow',
      } },
    } });
    const originDeps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'lead', mode: 'plain', ctx: null,
      getCurrentSessionMetadata: () => createTestMetadata({ machineId: 'target-machine' }),
      getCurrentSessionWorkDepth: () => 0,
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      readRoleSources: createRoleSourceReaderV1({}), actionsSettingsProvider: createActionSettingsProvider({ scopeKey }) });
    expect(await originDeps.resolveAgentStartContext!(buildActionExecutorContextForRpc({
      callerAuthority: 'account_automation', callerInputAuthorization: authorization,
    }))).toMatchObject({ caller: { kind: 'originless', runId: 'run' } });
    const foreignAccount = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, accountId: 'another-owner', target: { kind: 'session', sessionId: 'lead' },
    } });
    expect(await originDeps.resolveAgentStartContext!(buildActionExecutorContextForRpc({
      callerAuthority: 'account_automation', callerInputAuthorization: foreignAccount,
    }))).toBeNull();
  });
  it('refuses configuration effects when Account override authority is unavailable', async () => {
    let metadata = createTestMetadata();
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => metadata,
      readRoleSources: createRoleSourceReaderV1({}),
      readSettingsOverrides: () => ({ status: 'unavailable', reason: 'catalog-loading' }),
      stageSessionStateMutation: async (mutation) => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); } });
    expect(await handlers.get(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)!({ sessionId: 'child',
      configuration: { overrides: {}, sessionRoles: {}, notes: 'Unobserved authority' } },
    { signal: new AbortController().signal, callerAuthority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'account_role_overrides_unavailable' });
    expect(metadata.work?.sessionRolesV1?.notes).not.toBe('Unobserved authority');
  });
  it('refuses an older Home dropping the Session origin even for a non-relaxing report copy', async () => {
    let metadata = createTestMetadata();
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => metadata,
      readRoleSources: createRoleSourceReaderV1({}),
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
    let reparentAfterObservation = false;
    let tightenOnFinalRelationRead = false;
    let selectBuilderOnFinalRelationRead = false;
    let relationReadCount = 0;
    let nativePolicy: 'allow' | 'deny' = 'allow';
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => target,
      readRoleSources: createRoleSourceReaderV1({}),
      // Storage/transport snapshots are the boundary; the real caller resolver,
      // subtree parser, admission policy and registered mutation owner run below.
      resolveAgentStartContext: async (context, options) => resolveCliAgentStartContextV1({
        sessionId: 'lead', machineId: 'source-machine', directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        metadata: source, starterDepth: 2, turnDepth: 3, callerPermissionMode: context.callerPermissionMode ?? null, settings: null,
        ...(options?.purpose === 'session_scope' ? { roles: {} } : {}),
        accountRoleOverrides: { status: 'ready', overrides: {} },
        roleSourceInventory: await createRoleSourceReaderV1({})(),
      }),
      sessionRead: async () => ({ results: [{ sessionId: 'child', detail: inSubtree ? { status: 200,
        body: { session: createSessionRecordFixture({ id: 'child', active: true }) } }
        : { status: 404, body: { error: 'not_found' } } }] }),
      readCurrentReportLead: async () => {
        if ((tightenOnFinalRelationRead || selectBuilderOnFinalRelationRead) && ++relationReadCount === 2) {
          if (selectBuilderOnFinalRelationRead) target = writeSessionRoleIdV1ToMetadata(target, 'builder');
          else target = writeSessionRoleConfigurationV1ToMetadata(target, {
            inheritedFrom: 'lead', overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } },
            sessionRoles: {}, notes: 'User tightened hands-off',
          });
          if (tightenOnFinalRelationRead) expect(readSessionWorkspaceWritesV1(target)).toBe('deny');
        }
        const observed = currentLead;
        if (reparentAfterObservation) currentLead = 'other';
        return observed;
      },
      prepareWorkspaceWritesPolicy: async policy => { nativePolicy = policy; return { ok: true }; },
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
    currentLead = 'lead'; reparentAfterObservation = true;
    expect(await handler({ ...request, configuration: { ...request.configuration, notes: 'Detached during copy' } }, context))
      .toMatchObject({ ok: false, errorCode: 'session_target_not_led' });
    expect(target.work?.sessionRolesV1?.notes).toBe('Copied');
    reparentAfterObservation = false;
    currentLead = 'lead'; inSubtree = false;
    expect(await handler(request, context)).toMatchObject({ ok: false, errorCode: 'session_target_not_led' });
    inSubtree = true;
    source = { ...source, work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: 'Lead' } } };
    expect(await handler({ ...request, configuration: { ...request.configuration, notes: 'Relaxed' } }, context))
      .toMatchObject({ ok: false, errorCode: 'role_policy_denied' });
    expect(target).toMatchObject({ work: { sessionRolesV1: { notes: 'Copied' } } });
    source = writeSessionRoleIdV1ToMetadata(source, 'builder');
    tightenOnFinalRelationRead = true;
    const concurrentCopyResult = await handler(request, context);
    expect({ result: concurrentCopyResult, workspaceWrites: readSessionWorkspaceWritesV1(target) })
      .toMatchObject({ result: { ok: false, errorCode: 'role_policy_denied' }, workspaceWrites: 'deny' });
    target = createTestMetadata();
    relationReadCount = 0;
    tightenOnFinalRelationRead = false;
    selectBuilderOnFinalRelationRead = true;
    const newlySelectedResult = await handler({ ...request, configuration: { ...request.configuration,
      overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } },
    } }, context);
    expect({ result: newlySelectedResult, nativePolicy, workspaceWrites: readSessionWorkspaceWritesV1(target) })
      .toMatchObject({ result: { updated: true }, nativePolicy: 'deny', workspaceWrites: 'deny' });
  });
  it('rejects report copies when the authenticated caller cannot reach the target or allows forbidden writes', async () => {
    let metadata = createTestMetadata();
    const handlers = new Map<string, RpcHandler>();
    registerSessionRoleConfigurationHandler({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      sessionId: 'child', readSessionMetadata: () => metadata,
      readRoleSources: createRoleSourceReaderV1({}),
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
      readRoleSources: createRoleSourceReaderV1({}),
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
      readRoleSources: createRoleSourceReaderV1({}),
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
