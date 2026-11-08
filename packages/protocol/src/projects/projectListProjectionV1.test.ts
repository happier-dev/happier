import { describe, expect, it } from 'vitest';
import { projectProjectListV1, projectScopeKeysV1, resolveProjectContextSourceV1 } from './projectListProjectionV1.js';

describe('qualified Project context Source association', () => {
  it('uses accepted anchors, refuses unknown or competing Sources, and retains personal Projects', () => {
    const projectRef = { serverId: 'home', projectKey: 'project' };
    const workspace = { id: 'checkout', serverId: 'home', projectKey: 'project', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    expect(resolveProjectContextSourceV1({ projectRef, workspaceRefs: [], organizationPresent: false })).toEqual({ kind: 'unavailable' });
    expect(resolveProjectContextSourceV1({ projectRef, workspaceRefs: [workspace], organizationPresent: false })).toEqual({ kind: 'personal' });
    expect(resolveProjectContextSourceV1({ projectRef, workspaceRefs: [], organizationPresent: true })).toEqual({ kind: 'personal' });
    const source = { sourceId: 'source', revision: 1 };
    expect(resolveProjectContextSourceV1({ projectRef, workspaceRefs: [{ ...workspace, source }, { ...workspace, id: 'other', source }], organizationPresent: false }))
      .toEqual({ kind: 'source', sourceId: source.sourceId });
    expect(resolveProjectContextSourceV1({ projectRef, workspaceRefs: [{ ...workspace, source }, { ...workspace, id: 'other', source: { ...source, sourceId: 'competing' } }], organizationPresent: false }))
      .toEqual({ kind: 'unavailable' });
    expect(resolveProjectContextSourceV1({ projectRef, workspaceRefs: [{ ...workspace, serverId: 'foreign', source }], organizationPresent: false }))
      .toEqual({ kind: 'unavailable' });
  });
});

describe('curated Projects list (owner 11-08)', () => {
  const ref = (id: string, extra: Record<string, unknown> = {}) => ({ id, serverId: 'home', machineId: 'm', rootPath: `/${id}`, createdAtMs: 1, ...extra });
  const organization = (projectKey: string, value: Record<string, unknown>) => ({
    key: { kind: 'project-organization' as const, serverId: 'home', projectKey }, value });

  it('lists only Projects the person added: an organization row decides, else opened or a Source', () => {
    const projection = projectProjectListV1({ serverId: 'home', listing: 'listed', workspaceRefs: [
      ref('opened', { lastOpenedAtMs: 5 }),
      ref('sourced', { source: { sourceId: 'source', revision: 1 } }),
      ref('shown', {}),
      ref('hidden', { lastOpenedAtMs: 9 }),
      ref('session-old', { createdAtMs: 10 }),
      ref('session-new', { createdAtMs: 20 }),
    ], organizations: [organization('shown', { hidden: false }), organization('hidden', { hidden: true })] });
    expect(projection.listedProjectGroups.map(group => group.projectKey.projectKey).sort()).toEqual(['opened', 'shown', 'sourced']);
    // Session folders wait in "From your sessions", newest first; a hidden Project stays hidden.
    expect(projection.unlistedProjectGroups.map(group => group.projectKey.projectKey)).toEqual(['session-new', 'session-old']);
    expect(projection.hiddenProjectGroups.map(group => group.projectKey.projectKey)).toEqual(['hidden']);
    expect(projection.items.map(item => item.ref.id).sort()).toEqual(['opened', 'shown', 'sourced']);
    // Other consumers keep every visible Project unless they ask for the list.
    const all = projectProjectListV1({ serverId: 'home', workspaceRefs: [ref('opened', { lastOpenedAtMs: 5 }), ref('session-new')] });
    expect(all.items.map(item => [item.ref.id, item.listed])).toEqual([['opened', true], ['session-new', false]]);
    expect(all.projectGroups).toHaveLength(2);
  });

  it("gives one Project's scope as its anchor plus every member's own id, once each", () => {
    const projection = projectProjectListV1({ serverId: 'home', workspaceRefs: [
      ref('anchor', { projectKey: 'anchor' }), ref('joined', { projectKey: 'anchor' }), ref('worktree', { projectKey: 'anchor' }),
    ] });
    expect([...projectScopeKeysV1(projection.projectGroups[0]!)].sort()).toEqual(['anchor', 'joined', 'worktree']);
  });
});
