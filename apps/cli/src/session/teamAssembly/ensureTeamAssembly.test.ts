import { describe, expect, it, vi } from 'vitest';

import { readTeamAssemblyV1 } from '@happier-dev/protocol';

import { ensureTeamAssembly } from './ensureTeamAssembly';

const leadRole = { v: 1, role: 'project_lead', instructions: 'Lead.', assignmentId: 'assign_1', assignedAt: 1 };
const settingsOn = { visibleAgentsV1: { v: 1, assembleTeamOnLeadAssignment: true, teamTemplate: [{ role: 'reviewer', permissionMode: 'read_only' }, { role: 'worker' }] } };

function harness(overrides: Partial<Parameters<typeof ensureTeamAssembly>[0]> = {}) {
  let metadata: Record<string, unknown> = { sessionRoleV1: leadRole, permissionMode: 'yolo' };
  const created: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const deps: Parameters<typeof ensureTeamAssembly>[0] = {
    leadSessionId: 'lead',
    readLeadMetadata: () => metadata,
    readSettings: async () => settingsOn,
    listChildren: async () => [],
    createPlaceholder: vi.fn(async (creation) => {
      created.push(creation as unknown as Record<string, unknown>);
      return { sessionId: `ph_${created.length}` };
    }),
    updateLeadMetadata: async (updater) => {
      metadata = updater(metadata);
    },
    postNotice: async (text) => {
      notices.push(text);
    },
    getNowMs: () => 9,
    ...overrides,
  };
  return { deps, created, notices, metadata: () => metadata, setMetadata: (next: Record<string, unknown>) => { metadata = next; } };
}

describe('ensureTeamAssembly', () => {
  it('creates idle placeholders with the assembly origin, template controls, and role snapshots, then records and announces them', async () => {
    const t = harness();
    expect(await ensureTeamAssembly(t.deps)).toBe('assembled');
    expect(t.created).toEqual([
      expect.objectContaining({ role: 'reviewer', permissionMode: 'read_only', origin: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'assign_1' } } }),
      expect.objectContaining({ role: 'worker', origin: expect.objectContaining({ via: { kind: 'team_assembly', assignmentId: 'assign_1' } }) }),
    ]);
    expect(readTeamAssemblyV1(t.metadata())).toEqual({
      v: 1, assignmentId: 'assign_1', completedAt: 9, failed: [], skipped: [],
      created: [{ role: 'reviewer', sessionId: 'ph_1' }, { role: 'worker', sessionId: 'ph_2' }],
    });
    expect(t.notices[0]).toContain('Reviewer');
    expect(t.notices[0]).toContain('ph_1');
  });

  it('records a placeholder as created when its spawn call errors after the session already exists', async () => {
    const children: Array<Record<string, unknown>> = [];
    const t = harness({
      listChildren: async () => children as never,
      createPlaceholder: vi.fn(async (creation) => {
        if (creation.role === 'reviewer') {
          // The spawn created the session, then the call failed on the marker lock.
          children.push({ sessionId: 'reviewer_created', role: 'reviewer', archived: false, origin: creation.origin });
          throw new Error('Failed to spawn session: SESSION_MARKER_MUTATION_LOCK_TIMEOUT');
        }
        return { sessionId: 'worker_created' };
      }),
    });
    expect(await ensureTeamAssembly(t.deps)).toBe('assembled');
    expect(readTeamAssemblyV1(t.metadata())).toEqual(expect.objectContaining({
      created: [{ role: 'reviewer', sessionId: 'reviewer_created' }, { role: 'worker', sessionId: 'worker_created' }],
      failed: [],
    }));
    expect(t.notices[0]).toContain('reviewer_created');
    expect(t.notices[0]).not.toContain('could not be created');
  });

  it('is idempotent per assignment: a restart with the recorded assignment creates nothing', async () => {
    const t = harness();
    await ensureTeamAssembly(t.deps);
    expect(await ensureTeamAssembly(t.deps)).toBe('already_assembled');
    expect(t.created).toHaveLength(2);
  });

  it('counts an archived or recorded placeholder as existing on a new assignment', async () => {
    const t = harness({
      listChildren: async () => [{ sessionId: 'old_reviewer', role: 'reviewer', archived: true, origin: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'assign_0' } } }],
    });
    t.setMetadata({ sessionRoleV1: { ...leadRole, assignmentId: 'assign_2' }, teamAssemblyV1: { v: 1, assignmentId: 'assign_0', created: [{ role: 'worker', sessionId: 'deleted_worker' }], skipped: [], failed: [], completedAt: 1 } });
    expect(await ensureTeamAssembly(t.deps)).toBe('assembled');
    expect(t.created).toHaveLength(0);
    expect(readTeamAssemblyV1(t.metadata())?.skipped).toEqual([
      { role: 'reviewer', reason: 'existing_child', sessionId: 'old_reviewer' },
      { role: 'worker', reason: 'existing_child', sessionId: 'deleted_worker' },
    ]);
  });

  it('does nothing when the setting is off or the session is not a Project Lead', async () => {
    const off = harness({ readSettings: async () => ({}) });
    expect(await ensureTeamAssembly(off.deps)).toBe('disabled');
    const worker = harness();
    worker.setMetadata({ sessionRoleV1: { ...leadRole, role: 'worker' } });
    expect(await ensureTeamAssembly(worker.deps)).toBe('not_lead');
    expect(off.created).toHaveLength(0);
    expect(worker.created).toHaveLength(0);
  });

  it('records a visible failure and creates nothing hidden when the role-aware spawn is unavailable', async () => {
    const t = harness({ createPlaceholder: async () => { throw Object.assign(new Error('daemon cannot create role sessions'), { code: 'invalid_request' }); } });
    expect(await ensureTeamAssembly(t.deps)).toBe('assembled');
    expect(readTeamAssemblyV1(t.metadata())?.failed).toEqual([
      { role: 'reviewer', error: 'daemon cannot create role sessions' },
      { role: 'worker', error: 'daemon cannot create role sessions' },
    ]);
    expect(t.notices[0]).toContain('could not be created');
  });
});
