import { describe, expect, it } from 'vitest';
import { resolveProjectContextSourceV1 } from './projectListProjectionV1.js';

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
