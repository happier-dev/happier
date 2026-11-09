import { describe, expect, it } from 'vitest';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { readSkillLockV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { computeGitBlobShaV1, computeGitTreeShaV1, createRegistryHostV1, deriveRegistrySourceIdV1,
  REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { PromptBundleBodyV1Schema, PromptBundleArtifactHeaderV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import type { PromptLibraryArtifactStore, PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { RegistryHttpV1 } from '@happier-dev/protocol/registries';
import { createSkillsUpdateTracker } from './skillsUpdateTracker';
import { createRegistryUpdateCheck } from '../registryUpdateTracker';

const markdown = '---\nname: sample\n---\nInstructions';
const initial = '1'.repeat(40), latest = '2'.repeat(40);
const bytes = (text: string) => new TextEncoder().encode(text);
const files = (text: string) => [{ path: 'SKILL.md', unixMode: 0o644 as const, bytes: bytes(text) }];
function fixture(linkUrl?: string, written = false, provenance?: ReturnType<typeof readSkillLockV1>['provenance'], ids = ['sample']) {
  let writes = 0;
  let pages = 0;
  const opened: string[] = [];
  const selectedHeaders: string[][] = [];
  let artifact: PromptLibraryStoredArtifact = {
    id: 'sample', revision: { headerVersion: 1, bodyVersion: 1 }, owned: true,
    header: PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'sample', bundleSchemaId: 'skills.skill_md_v1',
      skillLock: { provenance: { kind: 'registry', registry: { sourceId: 'repo', format: 'git',
        sourceUrl: 'https://github.com/a/b', itemId: '', importedAt: 1,
        ref: { kind: 'gitTree', repo: 'https://github.com/a/b', path: '', commit: initial, treeSha: computeGitTreeShaV1(files(markdown)) } } },
        updatePolicy: 'manual' } }),
    body: JSON.stringify({ v: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(markdown).toString('base64'), unixMode: 0o644 }], createdAtMs: 1, updatedAtMs: 1 }),
  };
  const initialBody = PromptBundleBodyV1Schema.parse(JSON.parse(artifact.body!));
  const lock = readSkillLockV1(artifact.header);
  artifact = { ...artifact, header: { ...artifact.header, skillLock: { ...lock,
    ...(written ? { provenance: { kind: 'written' as const } } : {}),
    ...(linkUrl && lock.provenance.kind === 'registry' ? { provenance: { kind: 'link' as const, url: linkUrl,
      ref: lock.provenance.registry.ref } } : {}), ...(provenance ? { provenance } : {}),
    importedDigest: computePromptBundleDigestV1(initialBody) } } };
  const store: PromptLibraryArtifactStore = {
    list: async () => { pages++; return { coverage: 'complete', items: ids.map(id => ({ id, header: artifact.header, updatedAtMs: 1, owned: true })) }; },
    readHeadersByIds: async selected => { selectedHeaders.push([...selected]); return selected.map(id => ({ status: 'fulfilled' as const,
      value: ids.includes(id) ? { ...artifact, id, body: null } : null })); },
    read: async id => { opened.push(id); return { ...artifact, id }; },
    update: async input => {
      if (JSON.stringify(input.expectedRevision) !== JSON.stringify(artifact.revision)) throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
      writes++; artifact = { ...artifact, header: input.header, body: input.body,
        revision: { headerVersion: artifact.revision.headerVersion + 1, bodyVersion: artifact.revision.bodyVersion + 1 } };
      return { revision: artifact.revision };
    },
  };
  // The HTTP and persisted Artifact/row ports are genuine process boundaries;
  // registry parsing, skill projections and CAS operation logic remain real.
  const http: RegistryHttpV1 = {
    getJson: async url => ({ ok: true, fetchedAt: 2, value: url.includes('/commits/') ? { sha: linkUrl && !url.endsWith('/develop') ? initial : latest }
      : { sha: computeGitTreeShaV1(files(markdown + '\nNew')), truncated: false, tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644',
        sha: computeGitBlobShaV1(bytes(markdown + '\nNew')), size: bytes(markdown + '\nNew').length }] } }),
    getText: async () => ({ ok: true, fetchedAt: 2, value: markdown + '\nNew' }),
    getBytes: async () => ({ ok: true, fetchedAt: 2, value: bytes(markdown + '\nNew') }),
  };
  const registry = createRegistryHostV1({ host: 'node', http, readSources: async () => [{ id: 'repo', format: 'git', title: 'Repo',
    url: 'https://github.com/a/b', kinds: ['skill'], enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true }] });
  const execute = createSkillActionExecuteV1({ store, randomId: () => 'rule', nowMs: () => 2,
    skillRules: { serverId: 'home', assertCurrent: () => {}, listSkills: async () => [{ id: 'sample', name: 'sample' }],
      ruleWriteContext: () => ({ nowMs: 2, newId: () => 'rule' }),
      readCatalog: async () => { if (written) throw new Error('Display catalogs are unavailable during an upstream-only check');
        return { catalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [] } } }], tombstones: [], diagnostics: [] } }; },
      writeRecord: async () => { throw new Error('No reach writes during update observation'); } },
    includeInSession: async () => { throw new Error('No Session writes during update observation'); },
    readRegistryItem: registry.readRegistryItem, readRegistrySource: registry.readRegistrySource,
    fetchRegistrySkillFiles: registry.filesForPointer, readLinkSkills: registry.readLinkSkills, fetchLinkSkillFiles: registry.fetchLinkSkillFiles,
  });
  return { get artifact() { return artifact; }, execute, http, writes: () => writes, opened, selectedHeaders, pages: () => pages, observation: { state: 'update_available' as const,
    latest: { kind: 'gitTree' as const, repo: 'https://github.com/a/b', path: '', commit: latest, treeSha: computeGitTreeShaV1(files(markdown + '\nNew')) } } };
}
describe('skill update observations through the existing operation owner', () => {
  it('acquires only selected headers and bodies, with full enumeration reserved for full checks', async () => {
    const h = fixture(undefined, false, undefined, ['sample', 'unrelated']);
    const tracker = createSkillsUpdateTracker({ execute: h.execute });
    const check = createRegistryUpdateCheck({ trackers: [tracker], ctx: { http: h.http }, readSources: async () => [{ id: 'repo',
      format: 'git', title: 'Repo', url: 'https://github.com/a/b', kinds: ['skill'], enabled: true, addedAt: 1,
      origin: { kind: 'user' }, removable: true }] });
    expect((await check.checkNow({ kind: 'skill', keys: ['sample'] })).results).toMatchObject([{ key: 'sample',
      upstream: { state: 'update_available', latest: { commit: latest } } }]);
    expect(h.pages()).toBe(0);
    expect(h.selectedHeaders).toEqual([['sample']]);
    // One listing read plus the existing observation/CAS owner's baseline, write admission and result reads.
    expect(h.opened).toEqual(['sample', 'sample', 'sample', 'sample']);
    expect(readSkillLockV1(h.artifact.header).upstream).toEqual(h.observation);
    h.opened.length = 0;
    await tracker.list();
    expect(h.pages()).toBe(1);
    expect(h.opened.sort()).toEqual(['sample', 'unrelated']);
  });
  it.each(['git link', 'well-known index'] as const)('labels an unchecked %s by its source rather than the skill title', async kind => {
    const sourceUrl = kind === 'git link' ? 'https://github.com/a/b/tree/develop' : 'https://skills.example.test/team';
    const h = kind === 'git link' ? fixture(sourceUrl) : fixture(undefined, false, {
      kind: 'wellKnown', indexUrl: sourceUrl, name: 'sample', digest: `sha256:${'a'.repeat(64)}`,
    });
    const http: RegistryHttpV1 = { ...h.http, getJson: async () => ({ ok: false, status: { state: 'rate_limited' } }) };
    const check = createRegistryUpdateCheck({ trackers: [createSkillsUpdateTracker({ execute: h.execute })],
      ctx: { http }, readSources: async () => [] });
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(await check.checkNow());
    expect(result.results).toEqual([{ kind: 'skill', key: 'sample', sourceId: `link:${deriveRegistrySourceIdV1(sourceUrl)}`,
      sourceTitle: sourceUrl, upstream: { state: 'unchecked', reason: { state: 'rate_limited' } } }]);
    expect(h.writes()).toBe(0);
  });

  it('completes a written-only library check without display-catalog or upstream admission', async () => {
    const h = fixture(undefined, true);
    const check = createRegistryUpdateCheck({ trackers: [createSkillsUpdateTracker({ execute: h.execute })], ctx: { http: h.http },
      readSources: async () => { throw new Error('No installed upstream requires source admission'); } });
    expect(await check.checkNow({ kind: 'skill' })).toMatchObject({ results: [] });
    expect(h.writes()).toBe(0);
  });
  it('checks a linked GitHub skill against its admitted branch rather than repository HEAD', async () => {
    const h = fixture('https://github.com/a/b/tree/develop'), tracker = createSkillsUpdateTracker({ execute: h.execute });
    const check = createRegistryUpdateCheck({ trackers: [tracker], ctx: { http: h.http }, readSources: async () => [] });
    const result = await check.checkNow();
    expect(result.results).toMatchObject([{ key: 'sample', upstream: { state: 'update_available', latest: { commit: latest } } }]);
    expect(readSkillLockV1(h.artifact.header).upstream).toEqual(h.observation);
  });
  it('applies an already observed update after the user opts into auto without rewriting its observation', async () => {
    const h = fixture(), tracker = createSkillsUpdateTracker({ execute: h.execute });
    const check = createRegistryUpdateCheck({ trackers: [tracker], ctx: { http: h.http }, readSources: async () => [{
      id: 'repo', format: 'git', title: 'Repo', url: 'https://github.com/a/b', kinds: ['skill'], enabled: true,
      addedAt: 1, origin: { kind: 'user' }, removable: true,
    }] });
    await check.checkNow();
    const current = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', {}, { surface: 'cli' }))
      .items.find(item => item.skillId === 'sample')!;
    await h.execute('skills.update', { skillId: 'sample', expectedRevision: current.revision, updatePolicy: 'auto' }, { surface: 'ui' });
    const beforeApply = h.writes();
    await check.checkNow();
    expect(Buffer.from(JSON.parse(h.artifact.body!).entries[0].contentBase64, 'base64').toString()).toBe(markdown + '\nNew');
    expect(h.writes() - beforeApply).toBe(1);
    expect(readSkillLockV1(h.artifact.header).upstream?.state).toBe('current');
  });
  it('absorbs concurrent duplicate observations and refuses a check from an already advanced baseline', async () => {
    const h = fixture(), tracker = createSkillsUpdateTracker({ execute: h.execute });
    const baseline = (await tracker.list())[0]!;
    await Promise.all([h.execute.recordRegistryUpstream('sample', h.observation), h.execute.recordRegistryUpstream('sample', h.observation)]);
    expect(h.writes()).toBe(1);
    const current = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', {}, { surface: 'cli' })).items.find(item => item.skillId === 'sample')!;
    const applied = await h.execute('skills.updates.apply', { skillId: 'sample', expectedRevision: current.revision }, { surface: 'ui' });
    SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.apply'].parse(applied);
    const afterApply = h.writes();
    await tracker.record([{ key: 'sample', provenance: baseline.provenance, upstream: h.observation }]);
    expect(h.writes()).toBe(afterApply);
    expect(readSkillLockV1(h.artifact.header).upstream?.state).toBe('current');
  });
  it('fast-forwards opted-in unmodified content and leaves modified auto content for a choice', async () => {
    for (const modified of [false, true]) {
      const h = fixture();
      await h.execute('skills.update', { skillId: 'sample', expectedRevision: '1:1', updatePolicy: 'auto',
        ...(modified ? { files: [{ kind: 'upsert', file: { path: 'SKILL.md', contentKind: 'utf8',
          contentBase64: Buffer.from(markdown + '\nMy change').toString('base64'), unixMode: 0o644 } }] } : {}) }, { surface: 'ui' });
      const tracker = createSkillsUpdateTracker({ execute: h.execute });
      const before = await tracker.list();
      expect(before).toHaveLength(1);
      await tracker.record([{ key: 'sample', provenance: before[0]!.provenance, upstream: h.observation }]);
      const content = JSON.parse(h.artifact.body!).entries[0].contentBase64;
      expect(Buffer.from(content, 'base64').toString()).toBe(markdown + (modified ? '\nMy change' : '\nNew'));
      expect(readSkillLockV1(h.artifact.header).upstream?.state).toBe(modified ? 'update_available' : 'current');
    }
  });
  it('writes upstream once, keeps file bytes, and refuses a public caller-supplied upstream field', async () => {
    const h = fixture();
    expect(typeof h.execute.recordRegistryUpstream).toBe('function');
    const before = h.artifact.body;
    await h.execute.recordRegistryUpstream('sample', h.observation);
    await h.execute.recordRegistryUpstream('sample', h.observation);
    expect(h.writes()).toBe(1);
    expect(h.artifact.body).toBe(before);
    expect(JSON.parse(h.artifact.body!).entries).toEqual(JSON.parse(before!).entries);
    expect(readSkillLockV1(h.artifact.header).upstream).toEqual(h.observation);
    const listed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', {}, { surface: 'cli' }));
    expect(listed.items[0]?.upstream).toEqual(h.observation);
    await expect(h.execute('skills.update', { skillId: 'sample', expectedRevision: '2:2', upstream: h.observation }, { surface: 'cli' })).rejects.toThrow();
    expect(h.writes()).toBe(1);
  });
});
