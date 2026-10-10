import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountSettingsParse, BUILT_IN_ROLES_V1, readSessionRoleIdV1 } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createRoleActionExecutor } from './roleActions';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { RoleOverrideMutationV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';

describe('role Action effects', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ scopeKey: 'roles-test', source: 'network', settingsVersion: 1, settings: accountSettingsParse({}),
      rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  });
  afterEach(() => resetActiveAccountSettingsSnapshotForTests());
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

  it('groups shared roles by the grant access fact and retains migrated provenance', async () => {
    const role = BUILT_IN_ROLES_V1.builder;
    const execute = createRoleActionExecutor({ sessionId: '', artifactStore: {
      accessGrants: {
        list: async () => { throw new Error('Unexpected access grant list'); },
        set: async () => { throw new Error('Unexpected access grant set'); },
        remove: async () => { throw new Error('Unexpected access grant remove'); },
      },
      list: async () => ({ items: [{ artifactId: 'shared-role', ownerAccountId: 'other-account', header: { kind: 'role.v1' }, access: 'view', headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }], coverage: 'complete' }),
      read: async () => ({ artifactId: 'shared-role', ownerAccountId: 'other-account', access: 'view', header: { kind: 'role.v1', migratedFromV0_2: true }, body: JSON.stringify(role), revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 }),
      create: async () => { throw new Error('Unexpected create'); }, update: async () => { throw new Error('Unexpected update'); }, delete: async () => { throw new Error('Unexpected delete'); },
    } });
    expect(await execute({ actionId: 'roles.list', input: {}, context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ items: expect.arrayContaining([{ roleId: 'shared-role', role, revision: { headerVersion: 1, bodyVersion: 1 }, shared: true, viewOnly: true, migratedFromV0_2: true }]) });
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
