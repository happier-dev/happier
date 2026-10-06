import { describe, expect, it } from 'vitest';
import { createAccountRoleActionExecutorV1, type RoleArtifactStoreV1 } from './accountRoleActions.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import type { RolesV1 } from '../../account/settings/rolesV1.js';

const role = { name: 'Reviewer', instructions: 'Review the change', runsAs: { kind: 'session' },
  workspaceWrites: 'deny', secondOpinion: 'off', enabled: true } as const;

describe('Account Role artifact attribution', () => {
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
