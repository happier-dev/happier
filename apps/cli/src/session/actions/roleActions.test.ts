import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountSettingsParse, BUILT_IN_ROLES_V1, readSessionRoleIdV1, createActionExecutor, buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createRoleActionExecutor as createOwnerRoleActionExecutor } from './roleActions';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { RoleOverrideMutationV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RoleActionOutputSchemasV1, SessionRolesV1Schema, createRoleSourceReaderV1 } from '@happier-dev/protocol';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { writeSessionRoleConfigurationV1ToMetadata, writeSessionRoleIdV1ToMetadata } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { createRoleSourceReader } from '@/session/roles/roleSources';

// Storage is the test boundary; production callers supply their retained reader.
function createRoleActionExecutor(params: Parameters<typeof createOwnerRoleActionExecutor>[0]) {
  return createOwnerRoleActionExecutor({ readSettingsOverrides: () => {
    const snapshot = getActiveAccountSettingsSnapshot();
    return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot) : { status: 'unavailable', reason: 'source-unavailable' };
  }, ...params });
}

describe('role Action effects', () => {
  it.each([false, true])('reads only demanded Role bodies across scaled public edits (inherited snapshots: %s)', async inherited => {
    const currentRoleId = 'current-role';
    const requestedRoleId = 'requested-role';
    const allow = { ...BUILT_IN_ROLES_V1.builder, instructions: 'Current guidance', workspaceWrites: 'allow' as const };
    const deny = { ...BUILT_IN_ROLES_V1.builder, instructions: 'Requested guidance', workspaceWrites: 'deny' as const };
    const roles: Readonly<Record<string, typeof allow | typeof deny>> = { [currentRoleId]: allow, [requestedRoleId]: deny };
    const roleIds = [currentRoleId, requestedRoleId, ...Array.from({ length: 1_000 }, (_, index) => `unrelated-${index}`)];
    const costs = { pages: 0, bodies: 0 };
    const row = (artifactId: string) => ({ artifactId, ownerAccountId: 'account', access: 'owner' as const,
      header: { kind: 'role.v1' }, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      body: JSON.stringify(roles[artifactId] ?? allow) });
    // Only Artifact persistence is substituted. The public Action, selected
    // reader, Role precedence, native policy admission and outbox replay are real.
    const readRoleSources = createRoleSourceReader({ readPluginRoles: () => [], artifactStore: {
      read: async artifactId => {
        if (!roleIds.includes(artifactId)) return null;
        costs.bodies++;
        return { ...row(artifactId), revision: { headerVersion: 1, bodyVersion: 1 } };
      },
      list: async options => {
        costs.pages++;
        const start = Number(options?.cursor ?? 0);
        const ids = roleIds.slice(start, start + (options.limit ?? roleIds.length));
        costs.bodies += ids.length;
        const next = start + ids.length;
        return { coverage: 'complete', items: ids.map(row), ...(next < roleIds.length ? { nextCursor: String(next) } : {}) };
      },
    } });
    let metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: {
      roleId: currentRoleId, notes: '', overrides: {}, sessionRoles: inherited ? {
        [currentRoleId]: { ...allow, roleId: currentRoleId }, [requestedRoleId]: { ...deny, roleId: requestedRoleId },
      } : {},
    } } };
    let nativePolicy: 'allow' | 'deny' = 'allow';
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata, readRoleSources,
      prepareWorkspaceWritesPolicy: async policy => { nativePolicy = policy; return { ok: true }; },
      stageSessionStateMutation: async mutation => {
        queued.push(mutation);
        metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation);
      },
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.role.set": Object.keys(ActionSurfaceSchema.shape), "session.notes.set": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(), roleActionExecute });
    const backendTarget = { kind: 'backend', backendId: 'codex' } as const;
    const agentStartContext = resolveCliAgentStartContextV1({ sessionId: 'session-1', metadata,
      machineId: 'machine', directory: '/repo', backendTarget, starterDepth: 0, turnDepth: 0,
      callerPermissionMode: 'default', settings: accountSettingsParse({}), roles: {},
      appliedChildSelection: { status: 'applied', backendTarget, modelId: 'fixture-model', connectedServices: null },
    });
    if (!agentStartContext || 'ok' in agentStartContext) throw new Error('Missing admitted fixture Session');
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      callerPermissionMode: 'default', workspaceWrites: 'allow' as const, agentStartContext };
    const observedCosts: typeof costs[] = [];
    const captureCosts = () => { observedCosts.push({ ...costs }); costs.pages = 0; costs.bodies = 0; };
    expect(await executor.execute('session.role.set', { sessionId: 'session-1', roleId: requestedRoleId }, context))
      .toEqual({ ok: true, result: { updated: true } });
    expect({ roleId: readSessionRoleIdV1(metadata), nativePolicy,
      effectivePolicy: readSessionWorkspaceWritesV1(metadata, { settingsRoles: roles }) })
      .toEqual({ roleId: requestedRoleId, nativePolicy: 'deny', effectivePolicy: 'deny' });
    captureCosts();
    expect(await executor.execute('session.roles.override.set', { sessionId: 'session-1', roleId: currentRoleId,
      workspaceWrites: 'deny' }, context))
      .toEqual({ ok: true, result: { updated: true } });
    expect(metadata.work?.sessionRolesV1?.overrides[currentRoleId]).toMatchObject({
      workspaceWrites: 'deny',
    });
    expect(readSessionWorkspaceWritesV1(writeSessionRoleIdV1ToMetadata(metadata, currentRoleId), { settingsRoles: roles })).toBe('deny');
    captureCosts();
    expect(await executor.execute('session.roles.override.set', { sessionId: 'session-1', roleId: requestedRoleId,
      workspaceWrites: 'allow' }, context)).toMatchObject({ ok: false, errorCode: 'role_policy_denied' });
    expect(queued).toHaveLength(2);
    expect(nativePolicy).toBe('deny');
    captureCosts();
    expect(await executor.execute('session.notes.set', { sessionId: 'session-1', notes: 'New worker boundary' }, context))
      .toEqual({ ok: true, result: { updated: true } });
    expect(metadata.work?.sessionRolesV1?.notes).toBe('New worker boundary');
    expect(readSessionWorkspaceWritesV1(metadata, { settingsRoles: roles })).toBe('deny');
    captureCosts();
    expect(observedCosts).toEqual((inherited ? [0, 0, 0, 0] : [2, 2, 1, 1]).map(bodies => ({ pages: 0, bodies })));
  });
  it('changes worker-question answering through the role Action without replacing newer role configuration', async () => {
    let metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: {
      roleId: 'builder', inheritedFrom: 'lead', notes: 'Original notes',
      overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } }, sessionRoles: {},
    } } };
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      prepareWorkspaceWritesPolicy: async () => ({ ok: true }),
      stageSessionStateMutation: async mutation => { queued.push(mutation); },
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.role.set": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(), roleActionExecute });
    const context = { authority: 'present_user' as const, surface: 'ui' as const };
    expect(await executor.execute('session.role.set', { sessionId: 'session-1', answersWorkerQuestions: false }, context))
      .toEqual({ ok: true, result: { updated: true } });
    expect(queued).toHaveLength(1);
    const mutation = queued.shift();
    if (!mutation) throw new Error('Expected durable question preference edit');
    metadata = writeSessionRoleIdV1ToMetadata(metadata, 'reviewer');
    metadata = writeSessionRoleConfigurationV1ToMetadata(metadata, {
      inheritedFrom: 'lead', notes: 'Newer notes', sessionRoles: {},
      overrides: { scout: { roleId: 'scout', workspaceWrites: 'deny' } },
    });
    const beforeReplay = SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1);
    metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation);
    expect(SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1))
      .toEqual({ ...beforeReplay, answersWorkerQuestions: false });
    expect(await executor.execute('session.role.set', { sessionId: 'session-1', roleId: 'builder', answersWorkerQuestions: true }, context))
      .toEqual({ ok: true, result: { updated: true } });
    expect(queued).toHaveLength(1);
    metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, queued.shift()!);
    expect(SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1))
      .toEqual({ ...beforeReplay, roleId: 'builder', answersWorkerQuestions: true });
    expect(await executor.execute('session.role.set', { sessionId: 'session-1', roleId: 'reviewer' }, context))
      .toEqual({ ok: true, result: { updated: true } });
    metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, queued.shift()!);
    expect(SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1))
      .toEqual({ ...beforeReplay, roleId: 'reviewer', answersWorkerQuestions: true });
    for (const input of [{ sessionId: 'session-1' }, { sessionId: 'session-1', answersWorkerQuestions: 'false' },
      { sessionId: 'session-1', answersWorkerQuestions: false, configuration: {} }]) {
      expect(await executor.execute('session.role.set', input, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    expect(queued).toEqual([]);
  });
  it.each(['loading', 'source-unavailable', 'scope-retired'])('retains the closed override refusal reason %s', async reason => {
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => createTestMetadata(),
      readRoleSources: createRoleSourceReaderV1({}),
      readSettingsOverrides: () => ({ status: 'unavailable', reason }),
      stageSessionStateMutation: async () => { throw new Error('Unavailable authority must not write'); },
    });
    await expect(execute({ actionId: 'session.roles.override.clear', input: { sessionId: 'session-1', roleId: 'builder' },
      context: { authority: 'present_user', surface: 'rpc' } })).rejects.toMatchObject({
        code: 'account_role_overrides_unavailable', reason,
      });
  });
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ scopeKey: 'roles-test', source: 'network', settingsVersion: 1, settings: accountSettingsParse({}),
      rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  });
  afterEach(() => resetActiveAccountSettingsSnapshotForTests());
  it.each(['session.role.set', 'session.roles.override.clear'] as const)('refuses %s when the user tightens policy during final authority checking', async actionId => {
    const currentRoleId = actionId === 'session.role.set' ? 'scout' : 'builder';
    let metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: {
      roleId: currentRoleId, overrides: { [currentRoleId]: { roleId: currentRoleId, workspaceWrites: 'allow' } }, sessionRoles: {}, notes: '',
    } } };
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      readRoleSources: createRoleSourceReaderV1({}),
      beforeSessionMutation: async () => {
        metadata = writeSessionRoleConfigurationV1ToMetadata(metadata, {
          overrides: { [currentRoleId]: { roleId: currentRoleId, workspaceWrites: 'deny' } }, sessionRoles: {}, notes: 'User edit',
        });
        expect(readSessionWorkspaceWritesV1(metadata)).toBe('deny');
      },
      stageSessionStateMutation: async mutation => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    });
    await expect(execute({ actionId, input: { sessionId: 'session-1', roleId: 'builder' },
      context: { authority: 'account_automation', surface: 'rpc' } })).rejects.toMatchObject({ code: 'role_policy_denied' });
    expect(readSessionWorkspaceWritesV1(metadata)).toBe('deny');
  });
  it('rebases notes on a user policy tightening accepted during final authority checking', async () => {
    let metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: {
      roleId: 'builder', answersWorkerQuestions: false, overrides: {}, sessionRoles: {}, notes: '',
    } } };
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      readRoleSources: createRoleSourceReaderV1({}),
      beforeSessionMutation: async () => {
        metadata = writeSessionRoleConfigurationV1ToMetadata(metadata, {
          overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } }, sessionRoles: {}, notes: 'User edit',
        });
      },
      stageSessionStateMutation: async mutation => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    });
    expect(await execute({ actionId: 'session.notes.set', input: { sessionId: 'session-1', notes: 'New notes' },
      context: { authority: 'account_automation', surface: 'rpc' } })).toEqual({ updated: true });
    expect({ notes: metadata.work?.sessionRolesV1?.notes, answersWorkerQuestions: metadata.work?.sessionRolesV1?.answersWorkerQuestions,
      workspaceWrites: readSessionWorkspaceWritesV1(metadata) })
      .toEqual({ notes: 'New notes', answersWorkerQuestions: false, workspaceWrites: 'deny' });
  });
  it('preserves an unrelated user deny accepted while preparing a tighter native policy', async () => {
    let metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: {
      roleId: 'builder', answersWorkerQuestions: false, overrides: {}, sessionRoles: {}, notes: '',
    } } };
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      readRoleSources: createRoleSourceReaderV1({}),
      prepareWorkspaceWritesPolicy: async () => {
        metadata = writeSessionRoleConfigurationV1ToMetadata(metadata, {
          overrides: { scout: { roleId: 'scout', workspaceWrites: 'deny' } }, sessionRoles: {}, notes: 'User edit',
        });
        return { ok: true };
      },
      stageSessionStateMutation: async mutation => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    });
    expect(await execute({ actionId: 'session.roles.override.set', input: { sessionId: 'session-1', roleId: 'builder', workspaceWrites: 'deny' },
      context: { authority: 'account_automation', surface: 'rpc' } })).toEqual({ updated: true });
    expect(SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1)).toMatchObject({ notes: 'User edit', answersWorkerQuestions: false, overrides: {
      builder: { workspaceWrites: 'deny' }, scout: { workspaceWrites: 'deny' },
    } });
  });
  it('prepares native deny when the requested Role is tightened during final authority checking', async () => {
    let metadata = createTestMetadata();
    let nativePolicy: 'allow' | 'deny' = 'allow';
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      beforeSessionMutation: async () => {
        metadata = writeSessionRoleConfigurationV1ToMetadata(metadata, {
          overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } }, sessionRoles: {}, notes: 'User edit',
        });
      },
      prepareWorkspaceWritesPolicy: async policy => { nativePolicy = policy; return { ok: true }; },
      stageSessionStateMutation: async mutation => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    });
    expect(await execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'builder' },
      context: { authority: 'account_automation', surface: 'rpc' } })).toEqual({ updated: true });
    expect({ roleId: readSessionRoleIdV1(metadata), nativePolicy, workspaceWrites: readSessionWorkspaceWritesV1(metadata) })
      .toEqual({ roleId: 'builder', nativePolicy: 'deny', workspaceWrites: 'deny' });
  });
  it.each([false, true])('preserves a newly selected external Role deny without initial source inventory (complete snapshot: %s)', async completeSnapshot => {
    let metadata = createTestMetadata();
    const roleId = 'plugin:remote/readonly';
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      beforeSessionMutation: async () => {
        metadata = writeSessionRoleConfigurationV1ToMetadata(metadata, { overrides: {}, notes: '',
          sessionRoles: completeSnapshot ? { [roleId]: { ...BUILT_IN_ROLES_V1.reviewer, roleId } } : {},
        });
        metadata = writeSessionRoleIdV1ToMetadata(metadata, roleId);
        expect(readSessionWorkspaceWritesV1(metadata)).toBe('deny');
      },
      stageSessionStateMutation: async mutation => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    });
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'builder' },
      context: { authority: 'account_automation', surface: 'rpc' } })).rejects.toMatchObject({ code: 'role_policy_denied' });
    expect(readSessionRoleIdV1(metadata)).toBe(roleId);
  });
  it('writes an originless Run’s role and notes through canonical admission and the durable Session owner', async () => {
    let metadata = createTestMetadata();
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'origin',
      readSessionMetadata: () => metadata,
      readSettingsOverrides: () => ({ status: 'ready', overrides: {} }),
      readRoleSources: createRoleSourceReaderV1({}),
      // The outbox storage port is the boundary; real mutations are applied beneath it.
      stageSessionStateMutation: async mutation => {
        metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation);
      },
    });
    const startContext = resolveCliAgentStartContextV1({ sessionId: 'detached-step',
      machineId: 'machine', directory: '/repo', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      metadata: null, starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default', settings: null, roles: {},
      runCaller: { runId: 'workflow-run', runDepth: 4, runOriginSessionId: 'origin' } });
    if (!startContext || 'ok' in startContext) throw new Error('Expected host-produced Run caller');
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.role.set": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(), roleActionExecute });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      callerPermissionMode: 'default', workspaceWrites: 'allow' as const, agentStartContext: startContext };
    const role = await executor.execute('session.role.set', { sessionId: 'origin', roleId: 'builder' }, context);
    expect(role).toEqual({ ok: true, result: { updated: true } });
    if (!role.ok) throw new Error('Expected admitted Run role write');
    expect(RoleActionOutputSchemasV1['session.role.set'].parse(role.result)).toEqual(role.result);
    expect(readSessionRoleIdV1(metadata)).toBe('builder');
    expect(await executor.execute('session.notes.set', { sessionId: 'origin', notes: 'Run brief' }, context))
      .toEqual({ ok: true, result: { updated: true } });
    expect(SessionRolesV1Schema.parse(metadata.work?.sessionRolesV1).notes).toBe('Run brief');
    expect(await executor.execute('session.notes.set', { sessionId: 'unrelated', notes: 'Forbidden' }, context))
      .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    const { runOriginSessionId: _origin, ...callerWithoutOrigin } = startContext.caller.kind === 'originless'
      ? startContext.caller : (() => { throw new Error('Expected genuine originless caller'); })();
    expect(await executor.execute('session.notes.set', { sessionId: 'origin', notes: 'Forbidden' }, {
      ...context, agentStartContext: { ...startContext, caller: callerWithoutOrigin },
    })).toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(metadata.work?.sessionRolesV1?.notes).toBe('Run brief');
  });
  it('refuses an unenforceable built-in Role without waiting for unrelated Account inventory', async () => {
    let releaseSettings!: (value: Readonly<Record<string, unknown>>) => void;
    const settings = new Promise<Readonly<Record<string, unknown>>>(resolve => { releaseSettings = resolve; });
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'session-1', accountId: 'account-1',
      readRawAccountSettings: () => settings,
      readSessionMetadata: () => createTestMetadata(), stageSessionStateMutation: async () => {},
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), roleActionExecute });
    let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
    const pending = executor.execute('session.role.set', { sessionId: 'session-1', roleId: 'orchestrator' },
      { authority: 'present_user', surface: 'ui' }).then(value => { result = value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(result).toMatchObject({ ok: false, errorCode: 'role_policy_unenforceable' });
    } finally {
      releaseSettings({});
      await pending;
    }
  });
  it('serves a known complete Role but refuses unknown origin when legacy storage is unavailable', async () => {
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'session-1', accountId: 'account-1',
      readRawAccountSettings: async () => { throw new Error('Settings storage unavailable'); },
      readSessionMetadata: () => createTestMetadata(),
      stageSessionStateMutation: async (mutation) => { queued.push(mutation); },
    });
    const context = { authority: 'present_user' as const, surface: 'ui' as const };
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'builder' }, context }))
      .resolves.toEqual({ updated: true });
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'unknown-origin' }, context }))
      .rejects.toMatchObject({ code: 'role_source_incomplete' });
    expect(queued.map(mutation => mutation.fieldId)).toEqual(['intent.role']);
  });

  it('refuses report copies before writing a partial fresh Role inventory', async () => {
    const writes: string[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'lead', accountId: 'account-1',
      readRawAccountSettings: async () => { throw new Error('Settings storage unavailable'); },
      readSessionMetadata: () => ({ work: { sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: '' } } }),
      listReportSessions: async () => [{ sessionId: 'child', ownerAccountId: 'account-1' }],
      writeReportSessionRoles: async (sessionId) => { writes.push(sessionId); },
    });
    await expect(execute({ actionId: 'session.roles.apply_to_reports', input: { sessionId: 'lead' },
      context: { authority: 'present_user', surface: 'ui' } })).rejects.toMatchObject({ code: 'role_source_incomplete' });
    expect(writes).toEqual([]);
  });

  it('does not read the full Artifact inventory when no same-Account report can receive a snapshot', async () => {
    const execute = createRoleActionExecutor({ sessionId: 'lead', accountId: 'account-1',
      readSessionMetadata: () => ({ work: { sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: '' } } }),
      artifactStore: { list: async () => { throw new Error('Unneeded Artifact inventory'); },
        read: async () => null,
        create: async () => { throw new Error('Unexpected Artifact create'); },
        update: async () => { throw new Error('Unexpected Artifact update'); },
        delete: async () => { throw new Error('Unexpected Artifact delete'); },
        accessGrants: { list: async () => { throw new Error('Unexpected grants read'); },
          set: async () => { throw new Error('Unexpected grant write'); }, remove: async () => { throw new Error('Unexpected grant removal'); } },
      },
      listReportSessions: async () => [{ sessionId: 'foreign', ownerAccountId: 'other-account' }],
      writeReportSessionRoles: async () => { throw new Error('Foreign report must not be written'); },
    });
    expect(await execute({ actionId: 'session.roles.apply_to_reports', input: { sessionId: 'lead' },
      context: { authority: 'present_user', surface: 'ui' } })).toEqual({ updatedSessionIds: [] });
  });

  it.each([
    { memoryDocRef: { kind: 'doc', artifactId: 'private-memory' } },
    { retainedSessionContextEntry: { id: 'session.legacy-role-memory', ref: { kind: 'doc', artifactId: 'private-memory' },
      enabled: true, placement: 'system_append' } },
  ])('refuses new Role Actions that attempt to carry retained-only context authority (%j)', async (carrier) => {
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => createTestMetadata(),
      stageSessionStateMutation: async (mutation) => { queued.push(mutation); },
    });
    await expect(execute({ actionId: 'session.notes.set', input: { sessionId: 'session-1', notes: 'Keep notes', ...carrier },
      context: { authority: 'present_user', surface: 'ui' } })).rejects.toThrow();
    expect(queued).toEqual([]);
  });
  it('refuses Session writes when Account override authority is unavailable', async () => {
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => createTestMetadata(),
      readSettingsOverrides: () => ({ status: 'unavailable', reason: 'catalog-loading' }),
      stageSessionStateMutation: async (mutation) => { queued.push(mutation); },
    });
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'builder' },
      context: { authority: 'present_user', surface: 'ui' } })).rejects.toMatchObject({ code: 'account_role_overrides_unavailable' });
    expect(queued).toEqual([]);
  });
  it('does not relax native policy before a user relaxation is durably accepted', async () => {
    let nativePolicy: 'allow' | 'deny' = 'deny';
    const metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { roleId: 'builder',
      overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } }, sessionRoles: {}, notes: '' } } };
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      prepareWorkspaceWritesPolicy: async (policy) => { nativePolicy = policy; return { ok: true }; },
      stageSessionStateMutation: async () => { throw new Error('Durable enqueue failed'); },
    });
    await expect(execute({ actionId: 'session.roles.override.clear', input: { sessionId: 'session-1', roleId: 'builder' },
      context: { authority: 'present_user', surface: 'ui' } })).rejects.toThrow('Durable enqueue failed');
    expect(nativePolicy).toBe('deny');
    expect(metadata.work).toMatchObject({ sessionRolesV1: { overrides: { builder: { workspaceWrites: 'deny' } } } });
  });

  it('allows notes under an unchanged deny ceiling without restarting native policy', async () => {
    let metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } };
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      prepareWorkspaceWritesPolicy: async () => ({ ok: false, errorCode: 'role_policy_restart_required' }),
      stageSessionStateMutation: async (mutation) => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    });
    expect(await execute({ actionId: 'session.notes.set', input: { sessionId: 'session-1', notes: 'Coordinate the reports' },
      context: { authority: 'account_automation', surface: 'rpc' } })).toEqual({ updated: true });
    expect(metadata.work).toMatchObject({ sessionRolesV1: { roleId: 'orchestrator', notes: 'Coordinate the reports' } });
  });

  it('does not relax native policy before a user current-role change is durably accepted', async () => {
    let nativePolicy: 'allow' | 'deny' = 'deny';
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => ({
      work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } },
    }), prepareWorkspaceWritesPolicy: async (policy) => { nativePolicy = policy; return { ok: true }; },
      stageSessionStateMutation: async () => { throw new Error('Durable enqueue failed'); },
    });
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'builder' },
      context: { authority: 'present_user', surface: 'ui' } })).rejects.toThrow('Durable enqueue failed');
    expect(nativePolicy).toBe('deny');
  });

  it('refuses a native policy the bound runtime cannot enforce before queuing the role', async () => {
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => ({}),
      stageSessionStateMutation: async (mutation) => { queued.push(mutation); },
      prepareWorkspaceWritesPolicy: async () => ({ ok: false, errorCode: 'role_policy_unenforceable' }),
    });
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'orchestrator' },
      context: { authority: 'present_user', surface: 'ui' } })).rejects.toMatchObject({ code: 'role_policy_unenforceable' });
    expect(queued).toEqual([]);
  });
  it.each(['role_policy_unenforceable', 'role_policy_restart_required'])('preserves the Session owner refusal through the Action front door (%s)', async (errorCode) => {
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => ({}),
      stageSessionStateMutation: async (mutation) => { queued.push(mutation); },
      prepareWorkspaceWritesPolicy: async () => ({ ok: false, errorCode }),
    });
    // Other Action families are outside this test; Role resolution and failure mapping stay real.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), roleActionExecute });
    expect(await executor.execute('session.role.set', { sessionId: 'session-1', roleId: 'orchestrator' },
      { authority: 'present_user', surface: 'ui' })).toMatchObject({ ok: false, errorCode });
    expect(queued).toEqual([]);
  });
  it('routes a remote session edit through the target Action owner without touching local metadata', async () => {
    const forwarded: unknown[] = [];
    const context = { authority: 'present_user' as const, surface: 'ui' as const };
    const execute = createRoleActionExecutor({ sessionId: 'lead', forwardSessionRoleAction: async (request) => {
      forwarded.push(request); return { updated: true };
    } });
    const request = { actionId: 'session.notes.set' as const, input: { sessionId: 'child', notes: 'For the child' }, context };
    expect(await execute(request)).toEqual({ updated: true });
    expect(forwarded).toEqual([request]);
  });
  it.each(['thrown', 'envelope'] as const)('returns a typed runtime refusal when the role RPC is unavailable (%s)', async kind => {
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'lead', forwardSessionRoleAction: async () => {
      if (kind === 'thrown') throw createRpcCallError({ error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
      return { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'RPC method not available' };
    } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), roleActionExecute });
    expect(await executor.execute('session.role.set', { sessionId: 'child', roleId: 'orchestrator' },
      { authority: 'present_user', surface: kind === 'thrown' ? 'ui' : 'cli' })).toMatchObject({ ok: false, errorCode: 'session_role_runtime_unavailable' });
  });
  it('does not reinterpret a timed-out live Role write as an absent runtime', async () => {
    const failure = { ok: false, errorCode: 'session_rpc_failed', error: 'RPC call timeout' } as const;
    const roleActionExecute = createRoleActionExecutor({ sessionId: 'lead', forwardSessionRoleAction: async () => failure });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), roleActionExecute });
    expect(await executor.execute('session.role.set', { sessionId: 'child', roleId: 'orchestrator' },
      { authority: 'present_user', surface: 'cli' })).toEqual(failure);
  });
  it('deletes user roles through Artifact revision CAS, with approval and source protection', async () => {
    const deleted: string[] = [];
    const execute = createRoleActionExecutor({ sessionId: '', accountId: 'account-1',
      artifactStore: { list: async () => ({ items: [], coverage: 'complete' }),
        accessGrants: {
          list: async () => { throw new Error('Unexpected access grant list'); },
          set: async () => { throw new Error('Unexpected access grant set'); },
          remove: async () => { throw new Error('Unexpected access grant remove'); },
        },
        read: async (artifactId) => ({ artifactId, ownerAccountId: 'account-1', access: 'owner', header: { kind: 'role.v1' }, body: JSON.stringify(BUILT_IN_ROLES_V1.builder),
          revision: { headerVersion: 2, bodyVersion: 4 }, seq: 1, createdAt: 1, updatedAt: 1 }),
        create: async () => { throw new Error('Unexpected create'); }, update: async () => { throw new Error('Unexpected update'); },
        delete: async (artifactId, options) => {
          if (options?.expectedRevision?.bodyVersion !== 4) return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
          deleted.push(artifactId); return { ok: true };
        },
      } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    await expect(execute({ actionId: 'roles.delete', input: { roleId: 'orchestrator', expectedRevision: { headerVersion: 2, bodyVersion: 4 } }, context }))
      .rejects.toMatchObject({ code: 'role_read_only' });
    await expect(execute({ actionId: 'roles.delete', input: { roleId: 'user-role', expectedRevision: { headerVersion: 2, bodyVersion: 3 } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(await execute({ actionId: 'roles.delete', input: { roleId: 'user-role', expectedRevision: { headerVersion: 2, bodyVersion: 4 } }, context }))
      .toEqual({ deleted: true });
    await expect(execute({ actionId: 'roles.delete', input: { roleId: 'user-role', expectedRevision: { headerVersion: 2, bodyVersion: 4 } },
      context: { surface: 'agent', authority: 'account_automation' } })).rejects.toMatchObject({ code: 'approval_required' });
    expect(deleted).toEqual(['user-role']);
  });

  it('applies complete resolved snapshots only to proved same-Account reports and preserves their current role', async () => {
    let child: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: 'Child notes' } } };
    const writes: string[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'lead', accountId: 'account-1',
      readRoleSnapshotInputs: async () => ({ defaultEngine: { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }) },
        availableAgentTargetKeys: [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })] }),
      readSessionMetadata: () => ({ work: { sessionRolesV1: { overrides: { builder: { roleId: 'builder', instructionsOverride: 'Lead instruction' } },
        sessionRoles: {}, notes: 'Lead notes' }, promptStack: [{ id: 'lead-context', ref: { kind: 'doc', artifactId: 'memory' }, enabled: true, placement: 'system_append' }] } }),
      listReportSessions: async () => [{ sessionId: 'child', ownerAccountId: 'account-1' }, { sessionId: 'foreign', ownerAccountId: 'account-2' }],
      writeReportSessionRoles: async (sessionId, configuration) => {
        writes.push(sessionId);
        child = applyRegisteredSessionStateFieldMutationToMetadata(child, { v: 1, sessionId, mutationId: 'apply', fieldId: 'intent.sessionRoles',
          deliveryClass: 'durable_required', op: { kind: 'set', value: configuration }, source: 'runtime', observedAt: 1 });
      },
    });
    expect(await execute({ actionId: 'session.roles.apply_to_reports', input: { sessionId: 'lead' }, context: { surface: 'ui', authority: 'present_user' } }))
      .toEqual({ updatedSessionIds: ['child'] });
    expect(writes).toEqual(['child']);
    expect(child.work).toMatchObject({ sessionRolesV1: { roleId: 'builder', inheritedFrom: 'lead', notes: 'Lead notes',
      sessionRoles: { builder: { name: 'Builder', instructions: 'Lead instruction' } } } });
    expect(child.work).not.toHaveProperty('promptStack');
  });

  it.each([false, true])('applies the lead birth engine baseline after a notes edit (Use defaults: %s)', async useDefaults => {
    const backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
    const leadKey = buildBackendTargetKeyV2(backendTarget);
    const childKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
    const pluginRoleId = 'plugin:external/specialist';
    const sources = createRoleSourceReaderV1({ readPluginRoles: () => [{ pluginId: 'external', localId: 'specialist',
      role: { ...BUILT_IN_ROLES_V1.builder, name: 'Specialist' } }] });
    const inventory = await sources();
    let lead = createTestMetadata({ modelSelectionIntentV1: { v: 1,
      selection: { agentTargetKey: leadKey, providerConnectionId: null, modelId: 'lead-model' }, updatedAt: 1 },
      work: { sessionRolesV1: { roleId: 'builder', overrides: {
        reviewer: { roleId: 'reviewer', engine: { agentTargetKey: childKey, modelId: 'explicit-model' } },
      }, sessionRoles: {}, notes: '' } } });
    let child = createTestMetadata({ flavor: 'claude' });
    const availableAgentTargetKeys = [leadKey, childKey];
    const execute = createRoleActionExecutor({ sessionId: 'lead', accountId: 'account-1', readSessionMetadata: () => lead,
      readRoleSources: sources,
      readRoleSnapshotInputs: async () => ({ defaultEngine: { agentTargetKey: leadKey, modelId: 'lead-model' }, availableAgentTargetKeys }),
      stageSessionStateMutation: async mutation => { lead = applyRegisteredSessionStateFieldMutationToMetadata(lead, mutation); },
      listReportSessions: async () => [{ sessionId: 'child', ownerAccountId: 'account-1' }],
      writeReportSessionRoles: async (sessionId, configuration) => {
        child = applyRegisteredSessionStateFieldMutationToMetadata(child, { v: 1, sessionId, mutationId: 'copy', fieldId: 'intent.sessionRoles',
          deliveryClass: 'durable_required', op: { kind: 'set', value: configuration }, source: 'runtime', observedAt: 1 });
      },
    });
    const context = { surface: 'ui', authority: 'present_user' } as const;
    if (useDefaults) await execute({ actionId: 'session.roles.override.clear', input: { sessionId: 'lead', roleId: 'reviewer' }, context });
    await execute({ actionId: 'session.notes.set', input: { sessionId: 'lead', notes: 'Updated lead notes' }, context });
    const birth = resolveCliAgentStartContextV1({ sessionId: 'lead', metadata: lead, backendTarget,
      appliedChildSelection: { status: 'applied', backendTarget, modelId: 'lead-model', connectedServices: null },
      machineId: 'machine', directory: '/repo', starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default',
      settings: accountSettingsParse({}), roleSourceInventory: inventory,
      accountRoleOverrides: { status: 'ready', overrides: {} }, availableAgentTargetKeys });
    if (!birth || 'ok' in birth) throw new Error('Expected admitted birth context');
    expect(birth.roles.builder.engine).toEqual({ agentTargetKey: leadKey, modelId: 'lead-model' });
    expect(await execute({ actionId: 'session.roles.apply_to_reports', input: { sessionId: 'lead' }, context }))
      .toEqual({ updatedSessionIds: ['child'] });
    const inherited = SessionRolesV1Schema.parse(child.work?.sessionRolesV1);
    expect(inherited.notes).toBe('Updated lead notes');
    expect(inherited.sessionRoles).toEqual(birth?.roles);
    expect(inherited.sessionRoles[pluginRoleId]?.engine).toEqual({ agentTargetKey: leadKey, modelId: 'lead-model' });
    expect(inherited.sessionRoles.second_opinion.engine).toEqual({ agentTargetKey: childKey });
    expect(inherited.sessionRoles.reviewer.engine).toEqual(useDefaults
      ? { agentTargetKey: leadKey, modelId: 'lead-model' } : { agentTargetKey: childKey, modelId: 'explicit-model' });
  });
  it('persists current-role changes through the outbox and preserves unrelated session data at replay', async () => {
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const initial: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Original notes' } } };
    const execute = createRoleActionExecutor({
      sessionId: 'session-1', readSessionMetadata: () => initial,
      prepareWorkspaceWritesPolicy: async () => ({ ok: true }),
      stageSessionStateMutation: async (mutation) => { queued.push(mutation); },
    });
    expect(await execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'orchestrator' }, context: { authority: 'present_user', surface: 'ui' } })).toEqual({ updated: true });
    expect(readSessionRoleIdV1(initial)).toBeNull();
    expect(queued).toHaveLength(1);
    const latest = { ...initial, work: { otherWork: 'retained', sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'New notes' } } };
    const replayed = applyRegisteredSessionStateFieldMutationToMetadata(latest, queued[0]);
    expect(readSessionRoleIdV1(replayed)).toBe('orchestrator');
    expect(replayed.work).toEqual({ otherWork: 'retained', sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: 'New notes' } });
  });

  it('refuses unknown roles, another bound session, and an agent relaxing hands-off', async () => {
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => ({ work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } }), stageSessionStateMutation: async (mutation) => { queued.push(mutation); } });
    const context = { authority: 'account_automation' as const, surface: 'agent' as const, workspaceWrites: 'deny' as const };
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'missing' }, context })).rejects.toMatchObject({ code: 'role_target_unavailable' });
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'other-session', roleId: 'orchestrator' }, context })).rejects.toMatchObject({ code: 'session_target_unavailable' });
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'builder' }, context })).rejects.toMatchObject({ code: 'role_policy_denied' });
    expect(queued).toEqual([]);
  });

  it('edits session notes and overrides through the same outbox without changing the current role', async () => {
    let metadata: Metadata = { ...createTestMetadata(), work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } };
    const execute = createRoleActionExecutor({ sessionId: 'session-1', readSessionMetadata: () => metadata,
      prepareWorkspaceWritesPolicy: async () => ({ ok: true }),
      stageSessionStateMutation: async (mutation) => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); } });
    const context = { authority: 'present_user' as const, surface: 'ui' as const };
    expect(await execute({ actionId: 'session.notes.set', input: { sessionId: 'session-1', notes: 'Only change owned files' }, context })).toEqual({ updated: true });
    expect(await execute({ actionId: 'session.roles.override.set', input: { sessionId: 'session-1', roleId: 'builder', workspaceWrites: 'deny' }, context })).toEqual({ updated: true });
    expect(metadata.work).toMatchObject({ sessionRolesV1: { roleId: 'builder', notes: 'Only change owned files', overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } } });
    await expect(execute({ actionId: 'session.roles.override.clear', input: { sessionId: 'session-1', roleId: 'builder' }, context: { authority: 'account_automation', surface: 'agent', workspaceWrites: 'deny' } })).rejects.toMatchObject({ code: 'role_policy_denied' });
  });

  it('groups shared roles by grant access and still enforces an external current role before selecting a built-in', async () => {
    const role = { ...BUILT_IN_ROLES_V1.builder, workspaceWrites: 'deny' as const };
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'session-1',
      readSessionMetadata: () => ({ work: { sessionRolesV1: { roleId: 'shared-role', overrides: {}, sessionRoles: {}, notes: '' } } }),
      stageSessionStateMutation: async (mutation) => { queued.push(mutation); },
      artifactStore: {
      accessGrants: {
        list: async () => { throw new Error('Unexpected access grant list'); },
        set: async () => { throw new Error('Unexpected access grant set'); },
        remove: async () => { throw new Error('Unexpected access grant remove'); },
      },
      list: async () => ({ items: [{ artifactId: 'shared-role', ownerAccountId: 'other-account',
        header: { kind: 'role.v1', migratedFromV0_2: true }, access: 'view', headerVersion: 1, bodyVersion: 1,
        body: JSON.stringify(role), seq: 1, createdAt: 1, updatedAt: 1 }], coverage: 'complete' }),
      read: async () => ({ artifactId: 'shared-role', ownerAccountId: 'other-account', access: 'view', header: { kind: 'role.v1', migratedFromV0_2: true }, body: JSON.stringify(role), revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 }),
      create: async () => { throw new Error('Unexpected create'); }, update: async () => { throw new Error('Unexpected update'); }, delete: async () => { throw new Error('Unexpected delete'); },
    } });
    expect(await execute({ actionId: 'roles.list', input: {}, context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ items: expect.arrayContaining([{ roleId: 'shared-role', role, revision: { headerVersion: 1, bodyVersion: 1 }, shared: true, viewOnly: true, migratedFromV0_2: true }]) });
    await expect(execute({ actionId: 'session.role.set', input: { sessionId: 'session-1', roleId: 'builder' },
      context: { surface: 'agent', authority: 'account_automation' } })).rejects.toMatchObject({ code: 'role_policy_denied' });
    expect(queued).toEqual([]);
  });

  it('refuses malformed session role owner data before accepting a configuration edit', async () => {
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const execute = createRoleActionExecutor({ sessionId: 'session-1',
      readSessionMetadata: () => ({ work: { sessionRolesV1: { roleId: 'builder', notes: 'Retain me' } } }),
      stageSessionStateMutation: async (mutation) => { queued.push(mutation); },
    });
    await expect(execute({ actionId: 'session.notes.set', input: { sessionId: 'session-1', notes: 'New notes' },
      context: { surface: 'ui', authority: 'present_user' } })).rejects.toThrow();
    expect(queued).toEqual([]);
  });

  it('saves Account overrides only through the row writer and exposes a rejected transport effect', async () => {
    const mutations: RoleOverrideMutationV1[] = [];
    let failTransport = true;
    const execute = createRoleActionExecutor({ sessionId: '', accountId: 'account-1',
      readRawAccountSettings: async () => { throw new Error('Unexpected Settings read'); },
      mutateAccountRoleOverrides: async (mutation) => {
        if (failTransport) throw new Error('Role row transport failed');
        mutations.push(mutation);
      },
    });
    const request = { actionId: 'roles.override.set' as const, input: { roleId: 'builder', instructionsOverride: 'Build carefully' }, context: { surface: 'ui' as const, authority: 'present_user' as const } };
    await expect(execute(request)).rejects.toThrow('Role row transport failed');
    expect(mutations).toEqual([]);
    failTransport = false;
    expect(await execute(request)).toEqual({ updated: true });
    expect(mutations).toEqual([{ kind: 'set', override: request.input }]);
  });
});
