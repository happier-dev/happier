import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../../actions/actionExecutor.js';
import { createAccountRoleActionExecutorV1, createRoleSourceReaderV1, type RoleArtifactStoreV1 } from './accountRoleActions.js';
import { BUILT_IN_ROLES_V1 } from './builtInRolesV1.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import type { RolesV1 } from '../../account/settings/rolesV1.js';

function createHarness(readError?: Error) {
  let body = JSON.stringify(BUILT_IN_ROLES_V1.builder);
  let revision = { headerVersion: 1, bodyVersion: 1 };
  let deleted = false;
  let settingsWrites = 0;
  // Artifact/settings persistence is the system boundary; Role decisions and
  // the public Action admission/failure projection remain real.
  const artifactStore: RoleArtifactStoreV1 = {
    list: async () => ({ items: [] }),
    read: async (artifactId) => {
      if (readError) throw readError;
      return deleted ? null : ({ artifactId, header: { kind: 'role.v1' }, body, revision });
    },
    create: async () => { throw new Error('Unexpected create'); },
    update: async (input) => {
      if (input.expectedRevision.headerVersion !== revision.headerVersion || input.expectedRevision.bodyVersion !== revision.bodyVersion) {
        return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
      }
      body = input.body;
      revision = { headerVersion: revision.headerVersion + 1, bodyVersion: revision.bodyVersion + 1 };
      return { ok: true, revision };
    },
    delete: async (_artifactId, options) => {
      if (options?.expectedRevision?.headerVersion !== revision.headerVersion || options.expectedRevision.bodyVersion !== revision.bodyVersion) {
        return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
      }
      deleted = true;
      return { ok: true };
    },
  };
  const roleActionExecute = createAccountRoleActionExecutorV1({
    accountId: 'account', artifactStore, generateId: () => 'generated-role',
    mutateAccountSettings: async (mutate) => {
      await mutate({ rolesV1: { overrides: {} } });
      settingsWrites += 1;
    },
  });
  const unusedHostBoundary = async () => { throw new Error('Unexpected non-Role host boundary'); };
  const deps = {
    roleActionExecute,
    isActionApprovalRequired: () => false,
    executionRunStart: unusedHostBoundary,
    executionRunList: unusedHostBoundary,
    executionRunGet: unusedHostBoundary,
    detachedExecutionRunSend: unusedHostBoundary,
    executionRunStop: unusedHostBoundary,
    executionRunAction: unusedHostBoundary,
    executionRunWait: unusedHostBoundary,
    sessionOpen: unusedHostBoundary,
    sessionFork: unusedHostBoundary,
    sessionRollback: unusedHostBoundary,
    sessionSpawnNew: unusedHostBoundary,
    pathsListRecent: unusedHostBoundary,
    machinesList: unusedHostBoundary,
    serversList: unusedHostBoundary,
    reviewEnginesList: unusedHostBoundary,
    agentsBackendsList: unusedHostBoundary,
    agentsModelsList: unusedHostBoundary,
    sessionSendMessage: unusedHostBoundary,
    sessionModeSet: unusedHostBoundary,
    sessionModesList: unusedHostBoundary,
    sessionList: unusedHostBoundary,
    sessionActivityGet: unusedHostBoundary,
    sessionRecentMessagesGet: unusedHostBoundary,
    resetGlobalVoiceAgent: unusedHostBoundary,
    daemonMemorySearch: unusedHostBoundary,
    daemonMemoryGetWindow: unusedHostBoundary,
    daemonMemoryEnsureUpToDate: unusedHostBoundary,
  } satisfies ActionExecutorDeps;
  const execute = createActionExecutor(deps).execute;
  return { execute, state: () => ({ body, revision, deleted, settingsWrites }) };
}

const context = { surface: 'ui', authority: 'present_user' } as const;

describe('Account Role Action refusal projection', () => {
  it('preserves an unavailable Role read while keeping built-in reads available', async () => {
    const h = createHarness();
    expect(await h.execute('roles.get', { roleId: 'missing' }, context))
      .toMatchObject({ ok: false, errorCode: 'role_target_unavailable' });
    expect(await h.execute('roles.get', { roleId: 'builder' }, context))
      .toMatchObject({ ok: true, result: { roleId: 'builder', role: BUILT_IN_ROLES_V1.builder } });
    expect(h.state()).toMatchObject({ deleted: false, settingsWrites: 0 });
  });

  it('preserves source protection through the public executor before touching settings or Artifacts', async () => {
    const h = createHarness();
    for (const roleId of ['builder', 'plugin:acme/reviewer']) {
      expect(await h.execute('roles.delete', { roleId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
        .toMatchObject({ ok: false, errorCode: 'role_read_only' });
    }
    expect(h.state()).toMatchObject({ body: JSON.stringify(BUILT_IN_ROLES_V1.builder), revision: { headerVersion: 1, bodyVersion: 1 }, deleted: false, settingsWrites: 0 });
  });

  it.each(['roles.update', 'roles.delete'] as const)('preserves stale %s refusal and permits recovery with the current revision', async (actionId) => {
    const h = createHarness();
    const input = { roleId: 'user-role', expectedRevision: { headerVersion: 1, bodyVersion: 0 },
      ...(actionId === 'roles.update' ? { role: BUILT_IN_ROLES_V1.reviewer } : {}) };
    expect(await h.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(h.state()).toMatchObject({ body: JSON.stringify(BUILT_IN_ROLES_V1.builder), revision: { headerVersion: 1, bodyVersion: 1 }, deleted: false });
    expect(await h.execute(actionId, { ...input, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: true });
    expect(h.state()).toMatchObject(actionId === 'roles.update'
      ? { body: JSON.stringify(BUILT_IN_ROLES_V1.reviewer), revision: { headerVersion: 2, bodyVersion: 2 }, deleted: false }
      : { deleted: true });
  });

  it('leaves transport exceptions to the public failure normalizer rather than trusting their arbitrary code', async () => {
    const h = createHarness(Object.assign(new Error('Transport failed'), { code: 'role_read_only' }));
    expect(await h.execute('roles.delete', { roleId: 'user-role', expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'action_failed' });
    expect(h.state().deleted).toBe(false);
  });
});

const role = { name: 'Reviewer', instructions: 'Review the change', runsAs: { kind: 'session' },
  workspaceWrites: 'deny', secondOpinion: 'off', enabled: true } as const;

describe('Account Role artifact attribution', () => {
  it.each(['missing', 'non-text', 'invalid-json', 'invalid-role', 'read-failed'] as const)(
    'keeps built-in, plugin and available roles when another Artifact is %s', async (unavailable) => {
      const revision = { headerVersion: 1, bodyVersion: 1 };
      const header = { kind: 'role.v1', name: role.name };
      const read = createRoleSourceReaderV1({
        readPluginRoles: () => [{ pluginId: 'example', localId: 'review', role }],
        artifactStore: {
          list: async () => ({ items: ['unavailable', 'available'].map(artifactId => ({
            artifactId, header, access: 'owner', ownerAccountId: 'account', headerVersion: 1, updatedAt: 1,
          })) }),
          read: async artifactId => {
            if (artifactId === 'available') return { artifactId, header, revision, body: JSON.stringify(role) };
            if (unavailable === 'missing') return null;
            if (unavailable === 'read-failed') throw new Error('artifact_content_unavailable');
            return { artifactId, header, revision, body: unavailable === 'non-text' ? null
              : unavailable === 'invalid-json' ? '{' : JSON.stringify({ name: 'Incomplete' }) };
          },
        },
      });
      const entries = await read();
      expect(entries.find(entry => entry.roleId === 'orchestrator')?.role.name).toBe('Orchestrator');
      expect(entries.find(entry => entry.roleId === 'plugin:example/review')?.role).toEqual(role);
      expect(entries.find(entry => entry.roleId === 'available')?.role).toEqual(role);
      expect(entries.some(entry => entry.roleId === 'unavailable')).toBe(false);
    },
  );

  it('preserves cancellation when an Artifact read is interrupted', async () => {
    const controller = new AbortController();
    const read = createRoleSourceReaderV1({ artifactStore: {
      list: async () => ({ items: [{ artifactId: 'role', header: { kind: 'role.v1' }, access: 'owner',
        ownerAccountId: 'account', headerVersion: 1, updatedAt: 1 }] }),
      read: async () => { controller.abort(new Error('cancelled')); throw controller.signal.reason; },
    } });
    await expect(read(controller.signal)).rejects.toThrow('cancelled');
  });

  it('reads stored role documents and preferences with additive fields while keeping mutation inputs strict', async () => {
    const revision = { headerVersion: 1, bodyVersion: 1 };
    const header = { kind: 'role.v1', name: role.name };
    const read = createRoleSourceReaderV1({ artifactStore: {
      list: async () => ({ items: [{ artifactId: 'stored-role', header, access: 'owner',
        ownerAccountId: 'account', headerVersion: 1, updatedAt: 1 }] }),
      read: async () => ({ artifactId: 'stored-role', header, revision,
        body: JSON.stringify({ ...role, future: true, runsAs: { ...role.runsAs, future: true } }) }),
    } });
    expect((await read()).find(entry => entry.roleId === 'stored-role')?.role).toEqual(role);
    let settings: Record<string, unknown> = { rolesV1: { future: true, overrides: {
      builder: { roleId: 'builder', instructionsOverride: 'Keep', future: true },
    } } };
    const execute = createAccountRoleActionExecutorV1({ accountId: 'account', generateId: () => 'new-role',
      artifactStore: { read: async () => null, list: async () => ({ items: [] }),
        create: async input => ({ artifactId: input.artifactId, revision }),
        update: async () => ({ ok: true, revision }), delete: async () => ({ ok: true }) },
      mutateAccountSettings: async mutate => { settings = await mutate(settings); },
    });
    await execute({ actionId: 'roles.override.set', input: { roleId: 'scout', workspaceWrites: 'deny' }, context: { surface: 'cli' } });
    expect(settings.rolesV1).toEqual({ overrides: {
      builder: { roleId: 'builder', instructionsOverride: 'Keep' }, scout: { roleId: 'scout', workspaceWrites: 'deny' },
    } });
    await expect(execute({ actionId: 'roles.override.set', input: { roleId: 'scout', future: true }, context: { surface: 'cli' } })).rejects.toThrow();
  });
  it.each([
    { context: { surface: 'cli', runtimeAccountId: 'account', actionCaller: { kind: 'host' } }, savedBy: { kind: 'person', accountId: 'account' } },
    { context: { surface: 'mcp', runtimeAccountId: 'account', defaultSessionId: 'other-session', actionCaller: { kind: 'session', sessionId: 'admitted-session' } },
      savedBy: { kind: 'agent', accountId: 'account', sessionId: 'admitted-session' } },
  ] satisfies readonly { context: ActionExecutorContext; savedBy: unknown }[])('stamps retention, creation and update from the current caller ($savedBy.kind)', async ({ context, savedBy }) => {
    // Account Settings and Artifact persistence are boundaries; Role migration and mutation stay real.
    let settings: Record<string, unknown> = { executionRunsGuidanceEntries: [{ id: 'legacy', description: 'Retain this role' }] };
    const rows = new Map<string, NonNullable<Awaited<ReturnType<RoleArtifactStoreV1['read']>>>>();
    const writes: unknown[] = [];
    const artifactStore: RoleArtifactStoreV1 = {
      read: async id => rows.get(id) ?? null,
      list: async () => ({ items: [] }),
      create: async input => {
        const row = { ...input, revision: { headerVersion: 1, bodyVersion: 1 } };
        rows.set(input.artifactId, row); writes.push(input); return row;
      },
      update: async input => {
        const revision = { headerVersion: 2, bodyVersion: 2 };
        rows.set(input.artifactId, { ...input, revision }); writes.push(input); return { ok: true, revision };
      },
      delete: async () => ({ ok: true }),
    };
    const execute = createAccountRoleActionExecutorV1({ accountId: 'account', artifactStore, generateId: () => 'role',
      mutateAccountSettings: async (mutate: (raw: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown> & { rolesV1: RolesV1 }>) => { settings = await mutate(settings); } });
    await execute({ actionId: 'roles.create', input: { role }, context });
    expect(writes).toHaveLength(2);
    expect(writes).toEqual([expect.objectContaining({ savedBy, header: expect.objectContaining({ migratedFromV0_2: true }) }),
      expect.objectContaining({ artifactId: 'role', savedBy })]);
    await execute({ actionId: 'roles.update', input: { roleId: 'role', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, role: { ...role, name: 'Edited' } }, context });
    expect(writes[2]).toMatchObject({ savedBy });
    for (const row of rows.values()) {
      expect(row.header).not.toHaveProperty('savedBy');
      expect(JSON.parse(String(row.body))).not.toHaveProperty('savedBy');
    }
  });
});
