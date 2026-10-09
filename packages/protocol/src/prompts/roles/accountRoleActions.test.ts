import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../../actions/actionExecutor.js';
import { assertAccountRoleArtifactDeletionV1, createAccountRoleActionExecutorV1, createRoleSourceReaderV1, type RoleArtifactStoreV1 } from './accountRoleActions.js';
import { BUILT_IN_ROLES_V1 } from './builtInRolesV1.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import { applyRoleOverrideMutationV1, StoredRoleOverrideCatalogV1Schema, type RoleOverrideCatalogV1, type RoleOverrideMutationV1 } from './roleOverrideRecordV1.js';
import { readLegacyRoleInventoryV1 } from '../../account/settings/rolesV1Migration.js';

function createHarness(readError?: Error, guidanceSource?: Readonly<Record<string, unknown>> | Error | (() => Readonly<Record<string, unknown>>), storedArtifactId = 'user-role', retainedArtifactId?: string) {
  const record = (artifactId: string) => ({ artifactId, header: { kind: 'role.v1' }, body: JSON.stringify(BUILT_IN_ROLES_V1.builder),
    revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'account', access: 'owner' as const });
  const stored = record(storedArtifactId);
  const rows = new Map([[storedArtifactId, stored]]);
  if (retainedArtifactId) rows.set(retainedArtifactId, record(retainedArtifactId));
  let settingsWrites = 0;
  // Artifact/settings persistence is the system boundary; Role decisions and
  // the public Action admission/failure projection remain real.
  const artifactStore: RoleArtifactStoreV1 = {
    list: async () => ({ items: [...rows.values()].map(row => ({ ...row, headerVersion: row.revision.headerVersion, updatedAt: 1 })) }),
    read: async (artifactId) => {
      if (readError) throw readError;
      return rows.get(artifactId) ?? null;
    },
    create: async () => { throw new Error('Unexpected create'); },
    update: async (input) => {
      const current = rows.get(input.artifactId);
      if (!current || input.expectedRevision.headerVersion !== current.revision.headerVersion || input.expectedRevision.bodyVersion !== current.revision.bodyVersion) {
        return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
      }
      current.body = input.body;
      current.revision = { headerVersion: current.revision.headerVersion + 1, bodyVersion: current.revision.bodyVersion + 1 };
      return { ok: true, revision: current.revision };
    },
    delete: async (artifactId, options) => {
      const current = rows.get(artifactId);
      if (!current || options?.expectedRevision?.headerVersion !== current.revision.headerVersion || options.expectedRevision.bodyVersion !== current.revision.bodyVersion) {
        return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
      }
      rows.delete(artifactId);
      return { ok: true };
    },
  };
  const roleActionExecute = createAccountRoleActionExecutorV1({
    accountId: 'account', artifactStore, generateId: () => 'generated-role',
    readRawAccountSettings: async () => {
      if (guidanceSource instanceof Error) throw guidanceSource;
      return typeof guidanceSource === 'function' ? guidanceSource() : guidanceSource ?? { rolesV1: { overrides: {} } };
    },
    mutateAccountRoleOverrides: async () => {},
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
  return { execute, state: () => ({ body: stored.body, revision: stored.revision, deleted: !rows.has(storedArtifactId), settingsWrites }) };
}

const context = { surface: 'ui', authority: 'present_user' } as const;

describe('Account Role Action refusal projection', () => {
  it.each(['known-target-amid-unknown', 'unclassified-target'] as const)('preserves generic deletion refusal for %s', async (scenario) => {
    const [retained] = readLegacyRoleInventoryV1({ executionRunsGuidanceEntries: [{ id: 'retained', description: 'Keep guidance' }] }, 'account').entries;
    if (!retained) throw new Error('Expected current source target');
    await expect(assertAccountRoleArtifactDeletionV1({ accountId: 'account',
      artifactId: scenario === 'known-target-amid-unknown' ? retained.artifactId : 'unclassified',
      readTargetArtifactKind: () => scenario === 'known-target-amid-unknown' ? 'document.v1' : undefined,
      rawSettings: { executionRunsGuidanceEntries: scenario === 'known-target-amid-unknown'
        ? [{ id: 'retained', description: null }, { description: 'Missing identity' }] : null },
    })).rejects.toThrow('role_source_incomplete');
  });
  it('preserves a retained guidance target until actual current source cleanup, without blocking unrelated Role deletion', async () => {
    const guidance = { executionRunsGuidanceEntries: [{ id: 'legacy-delete', description: 'Retained guidance' }] };
    let raw: Readonly<Record<string, unknown>> = guidance;
    const [entry] = readLegacyRoleInventoryV1(raw, 'account').entries;
    if (!entry) throw new Error('Expected canonical guidance identity');
    const h = createHarness(undefined, () => raw, entry.artifactId);
    const input = { roleId: entry.artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
    expect(await h.execute('roles.delete', input, context)).toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
    expect(h.state().deleted).toBe(false);
    expect(await h.execute('roles.list', {}, context)).toMatchObject({ ok: true, result: {
      items: expect.arrayContaining([expect.objectContaining({ roleId: entry.artifactId })]),
    } });
    // This boundary now observes the acknowledged source cleanup; no Action-local source writer exists.
    raw = {};
    expect(await h.execute('roles.delete', input, context)).toMatchObject({ ok: true, result: { deleted: true } });
    expect(h.state().deleted).toBe(true);
    const unrelated = createHarness(undefined, guidance, 'ordinary-role', entry.artifactId);
    expect(await unrelated.execute('roles.delete', { ...input, roleId: 'ordinary-role' }, context)).toMatchObject({ ok: true });
  });
  it('serves a known canonical Role while reporting an unavailable pre-import guidance source', async () => {
    const h = createHarness(undefined, new Error('Settings transport unavailable'));
    expect(await h.execute('roles.get', { roleId: 'builder' }, context))
      .toMatchObject({ ok: true, result: { roleId: 'builder', role: BUILT_IN_ROLES_V1.builder } });
    expect(await h.execute('roles.list', {}, context)).toMatchObject({ ok: true, result: {
      diagnostics: [{ source: 'legacy-guidance', reason: 'unavailable' }],
    } });
    expect(await h.execute('roles.get', { roleId: 'unknown-origin' }, context))
      .toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
  });

  it('reports malformed retained guidance without pretending the source inventory is empty', async () => {
    const h = createHarness(undefined, { executionRunsGuidanceEntries: null });
    expect(await h.execute('roles.list', {}, context)).toMatchObject({ ok: true, result: {
      diagnostics: [{ source: 'legacy-guidance', reason: 'invalid_root' }],
    } });
  });
  it('mutates the admitted Role catalog without serializing overrides into Account Settings', async () => {
    let catalog: RoleOverrideCatalogV1 = { overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny', instructionsOverride: 'Keep' } } };
    let settingsWrites = 0;
    const artifactStore: RoleArtifactStoreV1 = { list: async () => ({ items: [] }), read: async () => null,
      create: async () => { throw new Error('Unexpected Role Artifact create'); },
      update: async () => { throw new Error('Unexpected Role Artifact update'); }, delete: async () => ({ ok: true }) };
    const execute = createAccountRoleActionExecutorV1({ accountId: 'account', artifactStore, generateId: () => 'role',
      readRawAccountSettings: async () => { settingsWrites += 1; throw new Error('Unexpected Settings access'); },
      mutateAccountRoleOverrides: async (mutation: RoleOverrideMutationV1) => { catalog = applyRoleOverrideMutationV1(catalog, mutation); },
    });
    await execute({ actionId: 'roles.override.set', input: { roleId: 'scout', workspaceWrites: 'deny', instructionsOverride: 'Scout' }, context });
    expect(catalog.overrides).toEqual({ builder: { roleId: 'builder', workspaceWrites: 'deny', instructionsOverride: 'Keep' },
      scout: { roleId: 'scout', workspaceWrites: 'deny', instructionsOverride: 'Scout' } });
    await execute({ actionId: 'roles.override.reset', input: { roleId: 'scout' }, context });
    expect(catalog.overrides).toEqual({ builder: { roleId: 'builder', workspaceWrites: 'deny', instructionsOverride: 'Keep' } });
    expect(settingsWrites).toBe(0);
  });
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
            if (artifactId === 'available') return { artifactId, header, revision, body: JSON.stringify(role), ownerAccountId: 'account', access: 'owner' as const };
            if (unavailable === 'missing') return null;
            if (unavailable === 'read-failed') throw new Error('artifact_content_unavailable');
            return { artifactId, header, revision, ownerAccountId: 'account', access: 'owner' as const, body: unavailable === 'non-text' ? null
              : unavailable === 'invalid-json' ? '{' : JSON.stringify({ name: 'Incomplete' }) };
          },
        },
      });
      const { entries } = await read();
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
      read: async () => ({ artifactId: 'stored-role', header, revision, ownerAccountId: 'account', access: 'owner' as const,
        body: JSON.stringify({ ...role, future: true, runsAs: { ...role.runsAs, future: true } }) }),
    } });
    expect((await read()).entries.find(entry => entry.roleId === 'stored-role')?.role).toEqual(role);
    let catalog = StoredRoleOverrideCatalogV1Schema.parse({ future: true, overrides: {
      builder: { roleId: 'builder', instructionsOverride: 'Keep', future: true },
    } });
    const execute = createAccountRoleActionExecutorV1({ accountId: 'account', generateId: () => 'new-role',
      artifactStore: { read: async () => null, list: async () => ({ items: [] }),
        create: async input => ({ artifactId: input.artifactId, revision }),
        update: async () => ({ ok: true, revision }), delete: async () => ({ ok: true }) },
      mutateAccountRoleOverrides: async mutation => { catalog = applyRoleOverrideMutationV1(catalog, mutation); },
    });
    await execute({ actionId: 'roles.override.set', input: { roleId: 'scout', workspaceWrites: 'deny' }, context: { surface: 'cli' } });
    expect(catalog).toEqual({ overrides: {
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
    const settings: Record<string, unknown> = { executionRunsGuidanceEntries: [{ id: 'legacy', description: 'Retain this role' }] };
    const rows = new Map<string, NonNullable<Awaited<ReturnType<RoleArtifactStoreV1['read']>>>>();
    const writes: unknown[] = [];
    const artifactStore: RoleArtifactStoreV1 = {
      read: async id => rows.get(id) ?? null,
      list: async () => ({ items: [] }),
      create: async input => {
        const row = { ...input, revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'account', access: 'owner' as const };
        rows.set(input.artifactId, row); writes.push(input); return row;
      },
      update: async input => {
        const revision = { headerVersion: 2, bodyVersion: 2 };
        rows.set(input.artifactId, { ...input, revision, ownerAccountId: 'account', access: 'owner' as const }); writes.push(input); return { ok: true, revision };
      },
      delete: async () => ({ ok: true }),
    };
    const execute = createAccountRoleActionExecutorV1({ accountId: 'account', artifactStore, generateId: () => 'role',
      readRawAccountSettings: async () => settings });
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
