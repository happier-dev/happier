import { describe, expect, it } from 'vitest';
import { admitProjectSourceSelectionV1, ProjectSourceV1Schema, ProjectSourceV1StoredSchema, ProjectSourcesCreateInputV1Schema, ProjectSourcesUpdateInputV1Schema, type ProjectSourceV1 } from './projectSourceV1.js';

const repository = {
  provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', visibility: 'private' },
  protocol: 'https',
};
describe('Source metadata admission', () => {
  it('normalizes execution identity while metadata and overridden defaults change', async () => {
    const captured = ProjectSourceV1Schema.parse({ id: 'source', revision: 1, name: 'Repo', repository, audience: [], createdByAccountId: 'owner', defaultRef: 'main', subdir: 'packages/app' });
    const current: ProjectSourceV1 = { ...captured, revision: 5, name: 'New name', defaultRef: 'changed', subdir: 'changed',
      repository: { ...captured.repository, provider: { ...captured.repository.provider, displayName: 'New label', baseUrl: 'https://GITHUB.com:443/' },
        repository: { ...captured.repository.repository, nameWithOwner: '/ACME/repo/', visibility: 'public', defaultBranch: 'changed' } } };
    expect(await admitProjectSourceSelectionV1({ serverId: 'home', sourceId: captured.id,
      captured: { selector: captured.repository, defaultRef: captured.defaultRef, subdir: captured.subdir },
      ref: 'main', subdir: 'packages\\.\\app/', readSource: async () => ({ ok: true, source: current, canManage: true }) }))
      .toMatchObject({ kind: 'admitted', ref: 'main', subdir: 'packages/app', sourceRevision: 5 });
  });
  it.each(['hosting', 'protocol', 'locator', 'ref', 'subdir'] as const)('refuses material %s changes without using revision as a gate', async change => {
    const source = ProjectSourceV1Schema.parse({ id: 'source', revision: 1, name: 'Repo', repository, audience: [], createdByAccountId: 'owner', defaultRef: 'main', subdir: 'packages/app' });
    const current: ProjectSourceV1 = { ...source,
      ...(change === 'ref' ? { defaultRef: 'other' } : change === 'subdir' ? { subdir: 'other' } : {}),
      repository: { ...source.repository,
        ...(change === 'hosting' ? { provider: { ...source.repository.provider, id: 'another-provider' } } : {}),
        ...(change === 'protocol' ? { protocol: 'auto' } : {}),
        ...(change === 'locator' ? { repository: { ...source.repository.repository, cloneUrl: 'https://github.com/acme/other.git' } } : {}) } };
    expect(await admitProjectSourceSelectionV1({ serverId: 'home', sourceId: source.id,
      captured: { selector: source.repository, defaultRef: source.defaultRef, subdir: source.subdir },
      readSource: async () => ({ ok: true, source: current, canManage: true }) }))
      .toEqual({ kind: 'refused', code: 'source_selection_changed' });
  });
  it('refuses credential-bearing or unknown locator fields and escaping subdirectories at write admission', () => {
    const input = { serverId: 'home', requestKey: 'save-intent', name: 'Repo', repository };
    expect(ProjectSourcesCreateInputV1Schema.safeParse(input).success).toBe(true);
    for (const cloneUrl of ['https://alice:secret@github.com/acme/repo.git', 'https://github.com/acme/repo.git?token=secret']) {
      expect(ProjectSourcesCreateInputV1Schema.safeParse({ ...input, repository: { ...repository, repository: { ...repository.repository, cloneUrl } } }).success).toBe(false);
    }
    expect(ProjectSourcesCreateInputV1Schema.safeParse({ ...input, repository: { ...repository, repository: { ...repository.repository, token: 'secret' } } }).success).toBe(false);
    expect(ProjectSourcesCreateInputV1Schema.safeParse({ ...input, subdir: '../outside' }).success).toBe(false);
  });
  it('drops stored nested extras while retaining required known fields and refuses malformed known fields', () => {
    const row = { id: 'source', revision: 1, name: 'Repo', repository, audience: [{ principal: { kind: 'team', teamId: 'team' }, level: 'view' }], createdByAccountId: 'owner' };
    const stored = { ...row, repository: { ...repository, repository: { ...repository.repository, future: true } }, audience: [{ ...row.audience[0], principal: { ...row.audience[0]!.principal, future: true } }] };
    expect(ProjectSourceV1StoredSchema.parse(stored)).toEqual(ProjectSourceV1Schema.parse(row));
    expect(ProjectSourceV1Schema.safeParse(stored).success).toBe(false);
    expect(ProjectSourceV1StoredSchema.safeParse({ ...stored, revision: 'broken' }).success).toBe(false);
  });
  it('admits a credential-free locator when repository visibility has not been discovered', () => {
    const { visibility: _visibility, ...locator } = repository.repository;
    expect(ProjectSourcesCreateInputV1Schema.safeParse({ serverId: 'home', requestKey: 'save-intent', name: 'Repo', repository: { ...repository, repository: locator } }).success).toBe(true);
  });
  it('rejects nested write extras but retains known historical context placements in stored reads', () => {
    const entry = { id: 'entry', ref: { kind: 'doc', artifactId: 'document', credential: 'forbidden' }, placement: 'composer_insert', enabled: true };
    const attachment = { purpose: 'context', entry };
    expect(ProjectSourcesUpdateInputV1Schema.safeParse({ serverId: 'home', sourceId: 'source', expectedRevision: 1, patch: { attachment: { kind: 'attach', attachment } } }).success).toBe(false);
    const row = { id: 'source', revision: 1, name: 'Repo', repository, audience: [], createdByAccountId: 'owner', attachments: [attachment] };
    expect(ProjectSourceV1StoredSchema.parse(row).attachments).toEqual([{ purpose: 'context', entry: { ...entry, ref: { kind: 'doc', artifactId: 'document' } } }]);
  });
});
