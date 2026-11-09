import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRegistryHostV1, type RegistryHttpV1 } from '@happier-dev/protocol/registries';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { PromptLibraryArtifactStore, PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { readSkillLockV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createSkillsUpdateTracker } from './updates/trackers/skillsUpdateTracker';
import { createRegistryUpdateCheck } from './updates/registryUpdateTracker';
import { installSkills, previewSkillInstall } from '../../../ui/sources/components/settings/skills/add/skillInstall';
import type { MountedAuthoringActionExecute } from '../../../ui/sources/sync/ops/actions/sessionAuthoringActions';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const markdown = (name: string, body = 'Reviewed instructions') => `---\nname: ${name}\ndescription: Useful instructions\n---\n${body}`;

function fixture(shape: 'legacy' | 'discovery', published = true) {
  const url = 'https://skills.sh/p/owned-pack';
  const indexUrl = `${url}/.well-known/skills/index.json`;
  const bodies = new Map<string, string>();
  const entries: Record<string, unknown>[] = [];
  const add = (name: string, body = markdown(name)) => {
    const fileUrl = `${url}/.well-known/skills/${name}/SKILL.md`;
    bodies.set(fileUrl, body);
    const entry = shape === 'legacy' ? { name, description: 'Useful instructions', files: ['SKILL.md'] }
      : { name, description: 'Useful instructions', type: 'skill-md', url: `${name}/SKILL.md`, ...(published ? { digest: digest(body) } : {}) };
    entries.push(entry);
    return { entry, fileUrl };
  };
  const primary = add('primary', markdown('primary', 'See [sibling](../sibling/SKILL.md)'));
  add('sibling');
  // HTTP and persistence are the only substituted system boundaries; Link,
  // digest verification, Action dispatch, held identity and Updates run for real.
  const http: RegistryHttpV1 = {
    getJson: async address => address === indexUrl
      ? { ok: true, value: { ...(shape === 'discovery' ? { $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json' } : {}), skills: entries }, fetchedAt: 1 }
      : { ok: false, status: { state: 'unreachable' } },
    getBytes: async address => bodies.has(address) ? { ok: true, value: new TextEncoder().encode(bodies.get(address)!), fetchedAt: 1 }
      : { ok: false, status: { state: 'unreachable' } },
    getText: async address => bodies.has(address) ? { ok: true, value: bodies.get(address)!, fetchedAt: 1 }
      : { ok: false, status: { state: 'unreachable' } },
  };
  const registry = createRegistryHostV1({ host: 'node', http, readSources: async () => [] });
  const artifacts = new Map<string, PromptLibraryStoredArtifact>();
  let nextId = 0;
  const store: PromptLibraryArtifactStore = {
    list: async () => ({ coverage: 'complete', items: [...artifacts.values()].map(item => ({ id: item.id, header: item.header, updatedAtMs: 1, owned: true })) }),
    read: async id => artifacts.get(id) ?? null,
    create: async input => {
      const id = `skill-${++nextId}`;
      artifacts.set(id, { ...input, id, owned: true, revision: { headerVersion: 1, bodyVersion: 1 } });
      return id;
    },
    update: async input => {
      const before = artifacts.get(input.artifactId)!;
      const revision = { headerVersion: before.revision.headerVersion + 1, bodyVersion: before.revision.bodyVersion + 1 };
      artifacts.set(before.id, { ...before, header: input.header, body: input.body, revision });
      return { revision };
    },
  };
  const action = createSkillActionExecuteV1({ store, randomId: () => 'rule', nowMs: () => 1,
    skillRules: { serverId: 'home', assertCurrent: () => {}, listSkills: async () => [],
      ruleWriteContext: () => ({ nowMs: 1, newId: () => 'rule' }),
      readCatalog: async () => ({ catalog: { status: 'ready', rows: [
        { revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [] } } },
      ], tombstones: [], diagnostics: [] } }),
      writeRecord: async () => ({ status: 'updated', revision: 1, cursor: 1 }) },
    includeInSession: async () => ({ ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' } }), readLinkSkills: registry.readLinkSkills, fetchLinkSkillFiles: registry.fetchLinkSkillFiles,
  });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    skillActionExecute: ({ actionId, input, context }) => action(actionId, input, { surface: context.surface ?? null }),
  });
  const execute: MountedAuthoringActionExecute = (actionId, input) => executor.execute(actionId, input, { surface: 'ui', authority: 'present_user' });
  return { url, indexUrl, bodies, entries, add, primary, artifacts, registry, http, action, execute };
}

describe('well-known Link → skills.install', () => {
  it.each(['legacy', 'discovery'] as const)('pins %s bytes, reuses held identities, offers siblings and tracks a digest update', async shape => {
    const f = fixture(shape);
    const preview = await previewSkillInstall(f.execute, { kind: 'link', url: f.url });
    expect(preview).toMatchObject({ ok: true, items: [{ path: 'primary', provenance: { kind: 'wellKnown', indexUrl: f.indexUrl, name: 'primary' }, siblingSkills: [{ path: 'sibling' }] }, { path: 'sibling' }] });
    if (!preview.ok) throw new Error(preview.error);
    const installed = await installSkills(f.execute, { source: preview.source, selectPaths: ['primary'], where: { kind: 'replace', rules: [] } });
    expect(installed).toMatchObject({ ok: true, skillIds: ['skill-1'] });
    expect(readSkillLockV1(f.artifacts.get('skill-1')!.header)).toMatchObject({ importedDigest: expect.stringMatching(/^sha256:/), provenance: { kind: 'wellKnown', indexUrl: f.indexUrl } });
    const originalDigest = readSkillLockV1(f.artifacts.get('skill-1')!.header).importedDigest;
    const mixed = await previewSkillInstall(f.execute, { kind: 'link', url: f.url });
    expect(mixed).toMatchObject({ ok: true, items: [{ inLibrary: 'skill-1' }, { path: 'sibling' }] });
    if (!mixed.ok) throw new Error(mixed.error);
    expect(await installSkills(f.execute, { source: mixed.source, where: { kind: 'replace', rules: [] } })).toMatchObject({ ok: true, skillIds: ['skill-1', 'skill-2'] });
    expect(f.artifacts.size).toBe(2);
    const held = await previewSkillInstall(f.execute, { kind: 'link', url: f.indexUrl });
    expect(held).toMatchObject({ ok: true, items: [{ inLibrary: 'skill-1' }, { inLibrary: 'skill-2' }] });
    if (!held.ok) throw new Error(held.error);
    expect(await installSkills(f.execute, { source: held.source, where: { kind: 'replace', rules: [] } })).toMatchObject({ ok: true, skillIds: ['skill-1', 'skill-2'] });
    expect([...f.artifacts.values()].map(item => item.revision)).toEqual([
      { headerVersion: 1, bodyVersion: 1 }, { headerVersion: 1, bodyVersion: 1 },
    ]);
    f.bodies.set(f.primary.fileUrl, markdown('primary', 'New upstream instructions'));
    if (shape === 'discovery') f.primary.entry.digest = digest(f.bodies.get(f.primary.fileUrl)!);
    const checker = createRegistryUpdateCheck({ trackers: [createSkillsUpdateTracker({ execute: f.action })], ctx: { http: f.http }, readSources: async () => [] });
    const updates = await checker.checkNow({ kind: 'skill' });
    expect(updates.results).toEqual(expect.arrayContaining([{ kind: 'skill', key: 'skill-1', upstream: { state: 'update_available', latest: expect.objectContaining({ kind: 'wellKnown', name: 'primary' }) } }]));
    const listed = await f.action('skills.list', {}, { surface: 'ui' });
    expect(listed).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ skillId: 'skill-1', upstream: expect.objectContaining({ state: 'update_available' }) })]) });
    expect(await f.action('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '2:2' }, { surface: 'ui' })).toMatchObject({ provenance: { kind: 'wellKnown' } });
    const updated = readSkillLockV1(f.artifacts.get('skill-1')!.header);
    expect(updated.importedDigest).not.toBe(originalDigest);
    expect(updated.provenance).toMatchObject({ kind: 'wellKnown', digest: updated.importedDigest });
  });

  it.each(['updated digest', 'bad digest', 'unsigned'] as const)('installs nothing when reviewed bytes change (%s)', async mode => {
    const published = mode !== 'unsigned';
    const f = fixture('discovery', published);
    const preview = await previewSkillInstall(f.execute, { kind: 'link', url: f.url });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(preview.error);
    f.bodies.set(f.primary.fileUrl, markdown('primary', 'Unreviewed replacement'));
    if (mode === 'updated digest') f.primary.entry.digest = digest(f.bodies.get(f.primary.fileUrl)!);
    expect(await installSkills(f.execute, { source: preview.source, where: { kind: 'replace', rules: [] } })).toMatchObject({ ok: false });
    expect(f.artifacts.size).toBe(0);
  });

  it('retains good items beside a bad digest and refuses incomplete legacy bundles', async () => {
    const f = fixture('discovery');
    f.add('bad').entry.digest = `sha256:${'0'.repeat(64)}`;
    const preview = await previewSkillInstall(f.execute, { kind: 'link', url: f.indexUrl });
    expect(preview).toMatchObject({ ok: true, items: [{ path: 'primary' }, { path: 'sibling' }] });
    if (!preview.ok) throw new Error(preview.error);
    expect(await installSkills(f.execute, { source: preview.source, where: { kind: 'replace', rules: [] } })).toMatchObject({ ok: true });
    const legacy = fixture('legacy');
    legacy.primary.entry.files = ['SKILL.md', 'missing.bin'];
    const completeOnly = await previewSkillInstall(legacy.execute, { kind: 'link', url: legacy.indexUrl });
    expect(completeOnly).toMatchObject({ ok: true, items: [{ path: 'sibling' }] });
  });

  it('uses the daemon fetch plan for packs and scoped site discovery without widening the scope', async () => {
    const f = fixture('legacy');
    const web = createRegistryHostV1({ host: 'web', http: {
      getJson: async () => { throw new Error('CORS-bound browser must use daemon'); },
      getText: async () => { throw new Error('CORS-bound browser must use daemon'); },
      getBytes: async () => { throw new Error('CORS-bound browser must use daemon'); },
    }, readSources: async () => [], daemonFetch: request => f.registry.fetchRequest(request) });
    expect(await web.readLinkSkills(f.url)).toHaveLength(2);
    expect(await web.fetchLinkSkillFiles(f.url, (await web.readLinkSkills(f.url))[0]!)).toHaveLength(1);
    await expect(f.registry.readLinkSkills('https://skills.sh/p/missing-pack')).rejects.toBeDefined();
  });
});
