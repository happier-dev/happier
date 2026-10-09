import { describe, expect, it } from 'vitest';
import { readProjectContextAttachmentTargetV1, updatePersonalProjectContextV1, ProjectContextUpdateInputV1Schema, type ProjectContextActionOwnerDepsV1 } from './projectContextV1.js';
import type { ProjectAccountOrganizationV1 } from './projectAccountRowsV1.js';
import type { ProjectSourceV1, ProjectSourcesUpdateInputV1 } from './sources/projectSourceV1.js';

function harness() {
  let value: ProjectAccountOrganizationV1 = { hidden: true, pinned: true };
  let revision: number | 'absent' = 'absent';
  let writes = 0;
  let reads = 0;
  const deps: ProjectContextActionOwnerDepsV1 = {
    accountScope: () => ({ serverId: 'home', accountId: 'account' }),
    readArtifact: async () => { reads++; return { id: 'doc', revision: { headerVersion: 0, bodyVersion: 0 },
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions', folderId: null, tags: [], origin: 'user', locked: false },
      body: JSON.stringify({ v: 1, markdown: 'Use the project conventions', createdAtMs: 0, updatedAtMs: 0 }) }; },
    // The persistent CAS boundary is represented in memory; semantic logic stays real.
    mutateOrganization: async input => {
      if (input.expectedRevision !== revision) return { status: 'conflict', revision: revision === 'absent' ? -1 : revision };
      const next = input.mutate(value);
      writes++; value = next; revision = revision === 'absent' ? 0 : revision + 1;
      return { status: 'updated', revision, value };
    },
  };
  return { deps, current: () => ({ value, revision, writes, reads }) };
}
const request = () => ProjectContextUpdateInputV1Schema.parse({ target: { serverId: 'home', projectKey: 'project' },
  expectedRevision: 'absent', intent: { kind: 'attach', entry: { id: 'entry', ref: { kind: 'doc', artifactId: 'doc' } } } });

describe('personal Project context Account Action owner', () => {
  it('captures the personal row CAS and keeps shared attachment admission at the Source boundary', async () => {
    const target = { serverId: 'home', projectKey: 'project' };
    const workspace = { id: 'checkout', ...target, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const personal = harness();
    const unusedSource = async (): Promise<never> => { throw new Error('A personal Project must not contact a Source'); };
    const captured = await readProjectContextAttachmentTargetV1({ readRows: async () => ({ workspaceRefs: [workspace], organizations: [] }),
      readSource: unusedSource, updateSource: unusedSource,
      updatePersonalContext: input => updatePersonalProjectContextV1(personal.deps, input),
    }, target);
    expect(captured.safety).toBe('safe');
    const entry = ProjectContextUpdateInputV1Schema.parse(request()).intent;
    if (entry.kind !== 'attach') throw new Error('Expected attach fixture');
    await expect(captured.attach(entry.entry)).resolves.toBe(true);
    await expect(captured.attach({ ...entry.entry, id: 'competing' })).resolves.toBe(false);
    expect(personal.current()).toMatchObject({ writes: 1, value: { hidden: true, pinned: true, promptStack: [{ id: 'entry' }] } });

    let canManage = true;
    let source: ProjectSourceV1 = { id: 'source', revision: 3, name: 'Shared', createdByAccountId: 'account', audience: [],
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git', visibility: 'public' }, protocol: 'https' },
      attachments: [{ purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dashboard' } }, { purpose: 'context', entry: entry.entry }] };
    const sourceWrites: ProjectSourcesUpdateInputV1[] = [];
    // Source reads and writes are HTTP boundaries; context routing and personal semantics stay real.
    const ports = { readRows: async () => ({ workspaceRefs: [{ ...workspace, source: { sourceId: source.id, revision: 3 } }], organizations: [] }),
      readSource: async () => ({ ok: true, source, canManage }),
      updateSource: async (input: ProjectSourcesUpdateInputV1) => {
        sourceWrites.push(input);
        if (input.patch.attachment?.kind !== 'attach') throw new Error('Expected semantic Source attachment');
        source = { ...source, revision: source.revision + 1,
          attachments: [...(source.attachments ?? []), input.patch.attachment.attachment] };
        return { ok: true, source, canManage };
      },
      updatePersonalContext: async (): Promise<never> => { throw new Error('Shared context must use its Source'); },
    };
    const shared = await readProjectContextAttachmentTargetV1(ports, target);
    expect(shared).toMatchObject({ safety: 'danger', entries: [{ id: 'entry', ref: { serverId: 'home' } }] });
    await expect(readProjectContextAttachmentTargetV1({ ...ports,
      readSource: async () => ({ ok: true, source: { ...source, id: 'wrong-source' }, canManage: true }),
    }, target)).rejects.toMatchObject({ code: 'project_context_unavailable' });
    await expect(shared.attach({ ...entry.entry, id: 'memory' })).resolves.toBe(true);
    expect(sourceWrites).toMatchObject([{ expectedRevision: 3, sourceId: 'source', patch: { attachment: {
      kind: 'attach', attachment: { purpose: 'context', entry: { id: 'memory' } },
    } } }]);
    expect(source.attachments).toMatchObject([{ purpose: 'dashboard' }, { purpose: 'context', entry: { id: 'entry' } },
      { purpose: 'context', entry: { id: 'memory' } }]);
    await expect(shared.attach(entry.entry)).resolves.toBe(false);
    expect(sourceWrites).toHaveLength(1);
    canManage = false;
    await expect(shared.attach(entry.entry)).rejects.toMatchObject({ code: 'project_context_access_denied' });
    await expect(readProjectContextAttachmentTargetV1(ports, target)).rejects.toMatchObject({ code: 'project_context_access_denied' });
    expect(sourceWrites).toHaveLength(1);
  });
  it('refuses scope retirement before the row write but preserves an already acknowledged effect receipt', async () => {
    let accountId = 'account';
    const before = harness();
    expect(await updatePersonalProjectContextV1({ ...before.deps,
      accountScope: () => ({ serverId: 'home', accountId }),
      readArtifact: async ref => { const value = await before.deps.readArtifact(ref); accountId = 'other'; return value; },
    }, request())).toEqual({ ok: false, errorCode: 'project_context_access_denied' });
    expect(before.current().writes).toBe(0);

    accountId = 'account';
    const after = harness();
    const result = await updatePersonalProjectContextV1({ ...after.deps,
      accountScope: () => ({ serverId: 'home', accountId }),
      mutateOrganization: async input => {
        const receipt = await after.deps.mutateOrganization(input);
        accountId = 'other';
        return receipt;
      },
    }, request());
    expect(result).toMatchObject({ ok: true, revision: 0 });
    expect(after.current().writes).toBe(1);
  });
  it('admits a currently readable memory document without confusing context read admission with public sharing', async () => {
    const fixture = harness();
    const result = await updatePersonalProjectContextV1({ ...fixture.deps,
      readArtifact: async () => ({ id: 'doc', revision: { headerVersion: 0, bodyVersion: 0 },
        header: { kind: 'memory_doc.v1' }, body: JSON.stringify({ v: 1, facts: [], archive: [] }) }),
    }, request());
    expect(result).toMatchObject({ ok: true, revision: 0, row: { promptStack: [{ id: 'entry' }] } });
    expect(fixture.current().writes).toBe(1);
  });
  it('admits current Artifact content before attaching under the exact caller CAS and preserves organization fields', async () => {
    const fixture = harness();
    const result = await updatePersonalProjectContextV1(fixture.deps, request());
    expect(result).toMatchObject({ ok: true, revision: 0, row: { hidden: true, pinned: true, promptStack: [{ id: 'entry' }] } });
    expect(fixture.current()).toMatchObject({ writes: 1, reads: 1 });
    expect(await updatePersonalProjectContextV1(fixture.deps, request())).toEqual({ ok: false, errorCode: 'project_context_conflict', currentRevision: 0 });
    expect(fixture.current().writes).toBe(1);
  });
  it('refuses wrong Home, unavailable Account and dashboard-kind attachments before a row write', async () => {
    const fixture = harness();
    expect(await updatePersonalProjectContextV1(fixture.deps, { ...request(), target: { serverId: 'wrong', projectKey: 'project' } }))
      .toEqual({ ok: false, errorCode: 'project_context_access_denied' });
    expect(await updatePersonalProjectContextV1({ ...fixture.deps, accountScope: () => null }, request()))
      .toEqual({ ok: false, errorCode: 'project_context_access_denied' });
    expect(await updatePersonalProjectContextV1({ ...fixture.deps, readArtifact: async () => ({ id: 'doc',
      revision: { headerVersion: 0, bodyVersion: 0 }, header: { kind: 'widget-surface.v1' }, body: '{}' }) }, request()))
      .toEqual({ ok: false, errorCode: 'artifact_wrong_kind' });
    expect(fixture.current().writes).toBe(0);
  });
});
