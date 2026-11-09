import { describe, expect, it } from 'vitest';
import { admitProjectSourceSelectionV1, ProjectSourceV1Schema, ProjectSourceV1StoredSchema, ProjectSourcesCreateInputV1Schema, ProjectSourcesUpdateInputV1Schema, type ProjectSourceV1 } from './projectSourceV1.js';
import { ScmRepositoryCloneInputSchema } from '../../scm/repositoryClone.js';

const repository = {
  provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', visibility: 'private' },
  protocol: 'https',
};
describe('Source metadata admission', () => {
  it('creates and reads a Source without a repository and preserves explicit repository removal', () => {
    const input = { serverId: 'home', requestKey: 'stored-app', name: 'App', owner: { kind: 'account', accountId: 'owner' } };
    expect(ProjectSourcesCreateInputV1Schema.parse(input)).toEqual(input);
    const source = { id: 'source', revision: 1, name: 'App', owner: input.owner, audience: [], createdByAccountId: 'owner' };
    expect(ProjectSourceV1Schema.parse(source)).toEqual(source);
    expect(ProjectSourceV1StoredSchema.parse(source)).toEqual(source);
    const update = { serverId: 'home', sourceId: 'source', expectedRevision: 1, patch: { repository: null } };
    expect(ProjectSourcesUpdateInputV1Schema.parse(update)).toEqual(update);
    expect(ProjectSourcesUpdateInputV1Schema.parse({ ...update, patch: { name: 'Renamed' } }).patch)
      .toEqual({ name: 'Renamed' });
  });
  it('keeps exactly one explicit Account or Team owner separate from plural audience', () => {
    const audience = ['view-team-a', 'view-team-b'].map(teamId => ({ principal: { kind: 'team', teamId }, level: 'view' }));
    const input = { serverId: 'home', requestKey: 'save-intent', name: 'Repo', repository, audience };
    const row = { id: 'source', revision: 1, name: 'Repo', repository, audience, createdByAccountId: 'creator' };
    for (const owner of [{ kind: 'account', accountId: 'creator' }, { kind: 'team', teamId: 'actual-owner' }]) {
      expect(ProjectSourcesCreateInputV1Schema.parse({ ...input, owner }).owner).toEqual(owner);
      expect(ProjectSourceV1StoredSchema.parse({ ...row, owner }).owner).toEqual(owner);
      expect(ProjectSourcesUpdateInputV1Schema.parse({ serverId: 'home', sourceId: 'source', expectedRevision: 1, patch: { owner } }).patch.owner)
        .toEqual(owner);
    }
    // Owner-less personal producers remain accepted during the additive S0 transition.
    // Audience order never chooses an owner; persistence admits and projects it.
    expect(ProjectSourcesCreateInputV1Schema.parse(input)).not.toHaveProperty('owner');
    expect(ProjectSourceV1StoredSchema.parse(row)).not.toHaveProperty('owner');
    for (const owner of [null, [], { kind: 'group', teamId: 'team', groupId: 'group' },
      { kind: 'account', accountId: 'creator', teamId: 'team' }, { kind: 'team', teamId: 'team', accountId: 'creator' },
      { kind: 'team', teamId: '' }]) {
      expect(ProjectSourcesCreateInputV1Schema.safeParse({ ...input, owner }).success).toBe(false);
      expect(ProjectSourceV1Schema.safeParse({ ...row, owner }).success).toBe(false);
      expect(ProjectSourceV1StoredSchema.safeParse({ ...row, owner }).success).toBe(false);
      expect(ProjectSourcesUpdateInputV1Schema.safeParse({ serverId: 'home', sourceId: 'source', expectedRevision: 1, patch: { owner } }).success)
        .toBe(false);
    }
  });
  it('returns needs_repository only after current Source read admission without inventing a selector', async () => {
    const source = { id: 'source', revision: 1, name: 'App', audience: [], createdByAccountId: 'owner' };
    for (const captured of [{}, { selector: ProjectSourcesCreateInputV1Schema.parse({
      serverId: 'home', requestKey: 'intent', name: 'Repo', repository }).repository }]) {
      expect(await admitProjectSourceSelectionV1({ serverId: 'home', sourceId: 'source', captured,
        readSource: async () => ({ ok: true, source, canManage: true }) }))
        .toEqual({ kind: 'refused', code: 'needs_repository' });
      expect(await admitProjectSourceSelectionV1({ serverId: 'home', sourceId: 'source', captured,
        readSource: async () => ({ ok: false, error: 'source_access_denied' }) }))
        .toEqual({ kind: 'refused', code: 'source_access_denied' });
    }
    expect(await admitProjectSourceSelectionV1({ serverId: 'home', sourceId: 'source', captured: {},
      readSource: async () => ({ ok: true, source: ProjectSourceV1Schema.parse({ ...source, repository }), canManage: true }) }))
      .toEqual({ kind: 'refused', code: 'source_selection_changed' });
  });
  it('canonicalizes accepted provider aliases on create, update and stored read before clone admission', () => {
    const legacyRepository = { ...repository, provider: { ...repository.provider, id: 'github' } };
    const created = ProjectSourcesCreateInputV1Schema.parse({ serverId: 'home', requestKey: 'save-intent', name: 'Repo', repository: legacyRepository });
    const updated = ProjectSourcesUpdateInputV1Schema.parse({ serverId: 'home', sourceId: 'source', expectedRevision: 1, patch: { repository: legacyRepository } });
    const stored = ProjectSourceV1StoredSchema.parse({ id: 'source', revision: 1, name: 'Repo', repository: legacyRepository, audience: [], createdByAccountId: 'owner' });
    for (const selector of [created.repository!, updated.patch.repository!, stored.repository!]) {
      const clone = ScmRepositoryCloneInputSchema.parse({ ...selector, destinationParentPath: '/projects',
        destinationDirectoryName: 'repo', confirmed: true, authorizationToken: 'clone-repository' });
      expect(selector.provider.id).toBe('happier.scm.forge.github/github');
      expect(clone.provider.id).toBe(selector.provider.id);
    }
  });
  it.each(['happier.scm.forge.github/github', 'acme.forge/custom', 'toString'])('preserves an exact non-alias provider identity (%s)', id => {
    const created = ProjectSourcesCreateInputV1Schema.parse({ serverId: 'home', requestKey: 'save-intent', name: 'Repo',
      repository: { ...repository, provider: { ...repository.provider, id } } });
    expect(created.repository!.provider.id).toBe(id);
  });
  it('admits enabled intent as one qualified context attachment change with a reviewed Source revision', () => {
    const input = { serverId: 'home', sourceId: 'source', expectedRevision: 3,
      patch: { attachment: { kind: 'set_enabled', attachmentId: 'context-entry', enabled: false } } };
    expect(ProjectSourcesUpdateInputV1Schema.parse(input)).toEqual(input);
    expect(ProjectSourcesUpdateInputV1Schema.safeParse({ ...input, patch: { attachment: { ...input.patch.attachment, enabled: 'false' } } }).success).toBe(false);
  });
  it.each(['.', './', '.\\', '', '   '])('reads and writes whole-repository selection canonically (%j)', subdir => {
    const input = { serverId: 'home', requestKey: 'save-intent', name: 'Repo', repository, subdir };
    expect(ProjectSourcesCreateInputV1Schema.parse(input).subdir).toBeUndefined();
    expect(ProjectSourcesUpdateInputV1Schema.parse({ serverId: 'home', sourceId: 'source', expectedRevision: 1,
      patch: { subdir } }).patch).toEqual({ subdir: null });
    expect(ProjectSourceV1StoredSchema.parse({ id: 'source', revision: 1, name: 'Repo', repository,
      subdir, audience: [], createdByAccountId: 'owner' }).subdir).toBeUndefined();
  });
  it('normalizes execution identity while metadata and overridden defaults change', async () => {
    const captured = ProjectSourceV1Schema.parse({ id: 'source', revision: 1, name: 'Repo', repository, audience: [], createdByAccountId: 'owner', defaultRef: 'main', subdir: 'packages/app' });
    const current: ProjectSourceV1 = { ...captured, revision: 5, name: 'New name', defaultRef: 'changed', subdir: 'changed',
      repository: { ...captured.repository!, provider: { ...captured.repository!.provider, displayName: 'New label', baseUrl: 'https://GITHUB.com:443/' },
        repository: { ...captured.repository!.repository, nameWithOwner: '/ACME/repo/', visibility: 'public', defaultBranch: 'changed' } } };
    expect(await admitProjectSourceSelectionV1({ serverId: 'home', sourceId: captured.id,
      captured: { selector: captured.repository, defaultRef: captured.defaultRef, subdir: captured.subdir },
      ref: 'main', subdir: 'packages\\.\\app/', readSource: async () => ({ ok: true, source: current, canManage: true }) }))
      .toMatchObject({ kind: 'admitted', ref: 'main', subdir: 'packages/app', sourceRevision: 5 });
  });
  it.each(['hosting', 'protocol', 'locator', 'ref', 'subdir'] as const)('refuses material %s changes without using revision as a gate', async change => {
    const source = ProjectSourceV1Schema.parse({ id: 'source', revision: 1, name: 'Repo', repository, audience: [], createdByAccountId: 'owner', defaultRef: 'main', subdir: 'packages/app' });
    const current: ProjectSourceV1 = { ...source,
      ...(change === 'ref' ? { defaultRef: 'other' } : change === 'subdir' ? { subdir: 'other' } : {}),
      repository: { ...source.repository!,
        ...(change === 'hosting' ? { provider: { ...source.repository!.provider, id: 'another-provider' } } : {}),
        ...(change === 'protocol' ? { protocol: 'auto' } : {}),
        ...(change === 'locator' ? { repository: { ...source.repository!.repository, cloneUrl: 'https://github.com/acme/other.git' } } : {}) } };
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
