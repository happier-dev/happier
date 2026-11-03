import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CLAUDE_PLUGIN } from '@happier-dev/plugins-claude/manifest';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { setImmediate } from 'node:timers/promises';
import retained from '../../../../../../packages/protocol/fixtures/0.2-retained-skill-path.json';
import retainedFrontmatter from '../../../../../../packages/protocol/fixtures/0.2-retained-skill-frontmatter.json';
import { PromptBundleBodyV1Schema, readSkillBundleContentV1, validatePromptBundleBodyV1AgainstSchemaId } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { ensureSkillSessionDirHttp } from '@/daemon/controlClient';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createSkillStore } from '../store/skillStore';
import { resolveRunnerSkills, type ResolveRunnerSkillsInput } from './resolveRunnerSkills';
import { prepareGeminiNativeMcpShaping } from '../../../../../../packages/plugins/gemini/src/agent/mcp/shaping';
import { resolveHappierSkillIdentity } from './resolveHappierSkillIdentity';
import { prepareSessionSkillPlan } from './prepareSessionSkillPlan';
import { publishRunnerSkillNotice } from './publishRunnerSkillNotice';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { PromptLibraryArtifactStore, PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createRegistryHostV1, computeGitBlobShaV1, computeGitTreeShaV1,
  type RegistryHttpV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import type { SkillArtifactStore } from '../library/readSkillLibraryContent';
import type { AccountArtifact, AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import {
  AgentRuntimeDaemonSessionOpenRequestV1Schema,
  AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema,
  projectAgentRuntimeDaemonSessionOpenAttestationRequestV1,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';

// Count the genuine filesystem boundary while preserving its real reads and every internal owner.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const dirs: string[] = [];
const stores: ReturnType<typeof createSkillStore>[] = [];
let restoreProjectHttp: () => void;
beforeEach(() => { restoreProjectHttp = installEmptyProjectAccountRowsHttpBoundary(); });
afterEach(() => { restoreProjectHttp(); });
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.releaseSkillSessionDirs('session');
    await store.collectSkillCache({ libraryDigests: [] });
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const bundle = (artifactId: string, name: string): AccountArtifact & AccountArtifactHeader => ({
  artifactId, ownerAccountId: 'account', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1,
  headerVersion: 1, bodyVersion: 1,
  header: { v: 1, kind: 'prompt_bundle.v2', title: 'Display title', bundleSchemaId: 'skills.skill_md_v1' },
  body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
    { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${name}\ndescription: Useful\n---\nFull body`).toString('base64') },
    { path: 'references/note.md', contentKind: 'utf8', contentBase64: Buffer.from('Supporting file').toString('base64'), retainedAnnotation: 'read-only extension' },
  ] }),
});
// These delivery scenarios isolate Account skills; built-in defaults have dedicated coverage.
const coreOff = { id: 'test-core-off', skillId: 'happier:happier', target: { t: 'allMachines' as const },
  enabled: false, createdAt: 1, updatedAt: 1 };
async function fixture(platform?: NodeJS.Platform) {
  const home = await mkdtemp(join(tmpdir(), 'happier-p3b-runner-')); dirs.push(home);
  const directory = join(home, 'project'); await mkdir(directory);
  const artifact = bundle('library', 'sample');
  const readIds: string[] = [];
  // Artifact persistence and daemon HTTP are genuine external boundaries; the store, scan and selection remain real.
  const artifacts: SkillArtifactStore = {
    list: async () => ({ items: [artifact, bundle('off', 'off')], coverage: 'complete' }),
    read: async id => { readIds.push(id); return id === 'library' ? artifact : bundle('off', 'off'); },
  };
  const store = createSkillStore({ happyHomeDir: join(home, 'happier'), platform });
  stores.push(store);
  const input: ResolveRunnerSkillsInput = {
    ownerKey: 'session', agentId: 'test', machineId: 'machine', directory, home,
    pluginSkills: [],
    credentials: { token: 'token', encryption: null }, sessionMetadata: {}, agentHasActionChannel: true,
    contributes: { catalogEntriesById: { test: { skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported' } } } },
    accountSnapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [coreOff,
        { id: 'everywhere', skillId: 'library', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
      ] } } }], tombstones: [], diagnostics: [] } },
  };
  return { home, directory, input, artifacts, store, readIds };
}
describe('runner skill resolution', () => {
  it('delivers feature-admitted built-ins for an existing Account and retains its explicit opt-out', async () => {
    const f = await fixture();
    const actualFetch = globalThis.fetch;
    let featureReads = 0;
    const featureHttp = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const href = url instanceof Request ? url.url : String(url);
      if (new URL(href).pathname !== '/v1/features') return actualFetch(url, init);
      featureReads++;
      return Promise.resolve(new Response(JSON.stringify({ features: { automations: { enabled: true }, workflows: { enabled: true }, deployments: { enabled: true } }, capabilities: {} })));
    });
    resetServerFeaturesClientForTests();
    try {
      const transports = { artifacts: f.artifacts, ensureSessionDir: (request: Parameters<typeof f.store.ensureSkillSessionDir>[0]) => f.store.ensureSkillSessionDir(request) };
      const input = { ...f.input, accountSnapshot: { ...f.input.accountSnapshot!, settings: accountSettingsParse({ featureToggles: { automations: true, deployments: true } }) } };
      const enabled = await resolveRunnerSkills(input, transports);
      expect(enabled.delivery?.items.map(item => item.skillId)).toEqual(['library', 'happier:deploy', 'happier:workflows']);
      const optedOut = await resolveRunnerSkills({ ...input, accountSnapshot: { ...input.accountSnapshot,
        settings: accountSettingsParse({ featureToggles: { automations: false, deployments: false } }) },
        sessionMetadata: { skillSelectionV1: { v: 1, forceIncludeSkillIds: ['happier:deploy', 'happier:workflows'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] } },
      }, transports);
      expect(optedOut.delivery?.items.map(item => item.skillId)).toEqual(['library']);
      expect(featureReads).toBe(1); // Both guides and the next plan share the Home feature owner.
      expect(input.accountSnapshot.promptLibraryCatalog).toEqual(f.input.accountSnapshot!.promptLibraryCatalog);
    } finally {
      featureHttp.mockRestore();
      resetServerFeaturesClientForTests();
    }
  });
  it('uses the daemon copy path for Agents whose plugin scanner rejects links', async () => {
    const f = await fixture();
    const input = { ...f.input, contributes: { catalogEntriesById: { test: {
      skills: { ...f.input.contributes!.catalogEntriesById.test!.skills!, materialization: 'copy' as const },
    } } } };
    const transports = { artifacts: f.artifacts, ensureSessionDir: (request: Parameters<typeof f.store.ensureSkillSessionDir>[0]) => f.store.ensureSkillSessionDir(request) };
    const linked = await resolveRunnerSkills(f.input, transports);
    expect(linked.delivery).toBeDefined();
    const result = await resolveRunnerSkills(input, transports);
    expect(result.unavailable).toBeUndefined();
    const root = result.delivery!.pluginRoot;
    const name = result.delivery!.items[0]!.name;
    expect((await fs.lstat(join(root, 'skills', name, 'SKILL.md'))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await fs.readFile(join(root, '.augment-plugin', 'marketplace.json'), 'utf8')))
      .toEqual({ name: 'happier', plugins: [{ name: 'happier', source: '.' }] });
    const before = await fs.stat(join(root, 'session.json'));
    await resolveRunnerSkills(input, transports);
    expect((await fs.stat(join(root, 'session.json'))).mtimeMs).toBe(before.mtimeMs);
  });
  it('skips unused native reads and folder creation only for an authoritative empty fresh start', async () => {
    const f = await fixture();
    const nativeRoot = join(f.home, '.native');
    await mkdir(nativeRoot);
    const input = { ...f.input, accountSnapshot: { ...f.input.accountSnapshot!, promptLibraryCatalog: {
      status: 'ready' as const, rows: [{ revision: 1, record: { key: 'skill-rules' as const, value: { v: 1 as const, rules: [coreOff] } } }],
      tombstones: [], diagnostics: [],
    } }, contributes: { catalogEntriesById: { test: {
      skills: { ...f.input.contributes!.catalogEntriesById.test!.skills!, nativeRoots: { user: [['.native']] } },
    } } } };
    const reads = vi.mocked(fs.readdir);
    reads.mockClear();
    let materializations = 0;
    const transports = { artifacts: f.artifacts, ensureSessionDir: async (request: Parameters<typeof f.store.ensureSkillSessionDir>[0]) => {
      materializations++; return f.store.ensureSkillSessionDir(request);
    } };
    const startedAt = performance.now();
    const fresh = await resolveRunnerSkills(input, transports);
    const nativeReads = reads.mock.calls.filter(([path]) => String(path) === nativeRoot).length;
    console.info('empty-start preparation', { nativeReads, materializations, durationMs: performance.now() - startedAt });
    expect({ nativeReads, materializations }).toEqual({ nativeReads: 0, materializations: 0 });
    expect(fresh.unavailable).toBeUndefined();
    expect(fresh.delivery).toBeUndefined();
    expect(f.readIds).toEqual([]);

    await rm(nativeRoot, { recursive: true });
    await writeFile(nativeRoot, 'An unreadable native directory');
    const preview = await prepareSessionSkillPlan({ inventory: [], artifacts: f.artifacts,
      selected: { items: [], excludeNativeSkillNames: [] },
      agentSkills: input.contributes.catalogEntriesById.test.skills, agentHasActionChannel: true,
      directory: f.directory, home: f.home, assertCurrent: async () => {} });
    expect(preview.nativeSkills?.status).toBe('failed');
    const unknown = await resolveRunnerSkills({ ...input, accountSnapshot: { ...input.accountSnapshot,
      promptLibraryCatalog: { status: 'unavailable', reason: 'invalid-stored-content' },
    } }, transports);
    expect(unknown).toMatchObject({ unavailable: true, unavailableReason: 'invalid-stored-content' });
    const disable = await resolveRunnerSkills({ ...input, sessionMetadata: { skillSelectionV1: {
      v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native'],
    } } }, transports);
    expect(disable).toMatchObject({ unavailable: true, unavailableReason: 'native_scan_failed' });
    const reapply = await resolveRunnerSkills({ ...input, lifecycle: 'reapply' }, transports);
    expect(reapply).toMatchObject({ unavailable: true, unavailableReason: 'native_scan_failed' });
    await rm(nativeRoot);
    const seeded = await resolveRunnerSkills({ ...input, sessionMetadata: { skillSelectionV1: {
      v: 1, forceIncludeSkillIds: ['library'], forceExcludeSkillIds: [], excludeNativeSkillNames: [],
    } } }, transports);
    expect(seeded.delivery?.items).toContainEqual(expect.objectContaining({ skillId: 'library' }));
    const cleared = await resolveRunnerSkills({ ...input, lifecycle: 'reapply' }, transports);
    expect(materializations).toBe(2);
    expect(cleared.delivery?.items).toEqual([]);
    expect(await readdir(cleared.delivery!.skillsRoot)).toEqual([]);
    const nativeSkill = join(nativeRoot, 'native', 'SKILL.md');
    await mkdir(join(nativeRoot, 'native'), { recursive: true });
    await writeFile(nativeSkill, '---\nname: native\n---\nNative instructions');
    const disableOnly = await resolveRunnerSkills({ ...input, sessionMetadata: { skillSelectionV1: {
      v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native'],
    } } }, transports);
    expect(disableOnly.delivery).toMatchObject({ items: [], nativeDisables: [{ name: 'native', path: nativeSkill }] });
    expect(materializations).toBe(3);
  });
  it.each([
    ['upload', 'source-b', false, undefined], ['upload', 'declared-b', false, undefined], ['upload', 'declared-b', true, undefined],
    ['link', 'source-b', false, undefined], ['link', 'declared-b', false, undefined], ['registry', 'declared-b', false, undefined],
    ['folder-link', 'declared-b', false, undefined], ['upload', 'declared-b', true, 'win32'],
  ] as const)('delivers %s sibling source folders (declared %s, renamed %s) through Add and runner wiring', async (kind, declaredName, rename, platform) => {
    const f = await fixture(platform);
    const md = (name: string, body = '') => `---\nname: ${name}\n---\n${body}`;
    const prefix = kind === 'folder-link' ? 'skills/' : '';
    const sourceFiles = [
      { path: `${prefix}a/SKILL.md`, unixMode: 0o644 as const, bytes: Buffer.from(md('a', 'Read [setup](../source-b/SKILL.md) and [README](../README.md).')) },
      { path: `${prefix}source-b/SKILL.md`, unixMode: 0o644 as const, bytes: Buffer.from(md(declaredName)) },
    ];
    const directories = [...new Set(sourceFiles.flatMap(file => file.path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))))];
    const commit = '1'.repeat(40);
    let head = commit;
    const source: RegistrySourceDescriptorV1 = { id: 'pack', title: 'Pack', format: 'git', kinds: ['skill'],
      url: 'https://github.com/o/pack', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
    const bytesAt = (url: string) => sourceFiles.find(file => url.endsWith('/' + file.path))!.bytes;
    // GitHub HTTP and independent Artifact persistence are the substituted system boundaries.
    const http: RegistryHttpV1 = {
      getJson: async url => url.includes('marketplace.json') ? { ok: false, status: { state: 'unreachable' } }
        : { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: url.endsWith('/HEAD') ? head : decodeURIComponent(url.split('/').at(-1)!) } : {
          sha: computeGitTreeShaV1(sourceFiles), tree: [
            ...directories.map(path => ({ path, mode: '040000', type: 'tree', sha: computeGitTreeShaV1(sourceFiles
              .filter(file => file.path.startsWith(path + '/')).map(file => ({ ...file, path: file.path.slice(path.length + 1) }))) })),
            ...sourceFiles.map(file => ({ path: file.path, mode: '100644', type: 'blob', sha: computeGitBlobShaV1(file.bytes), size: file.bytes.length })),
          ],
        } },
      getText: async url => {
        expect(url).toContain(`/${commit}/`);
        if (kind === 'folder-link') head = '2'.repeat(40);
        return { ok: true, fetchedAt: 1, value: bytesAt(url).toString('utf8') };
      },
      getBytes: async url => { expect(url).toContain(`/${commit}/`); return { ok: true, fetchedAt: 1, value: bytesAt(url) }; },
    };
    const registry = createRegistryHostV1({ host: 'node', http, readSources: async () => [source] });
    const persisted = new Map<string, PromptLibraryStoredArtifact>();
    const store: PromptLibraryArtifactStore = {
      list: async () => ({ coverage: 'complete', items: [...persisted.values()].map(item => ({ id: item.id, header: item.header, updatedAtMs: 1, owned: true })) }),
      read: async id => persisted.get(id) ?? null,
      create: async input => { const id = `import-${persisted.size}`;
        persisted.set(id, { id, ...input, owned: true, revision: { headerVersion: 1, bodyVersion: 1 } }); return id; },
      update: async input => { const item = persisted.get(input.artifactId)!;
        const revision = { headerVersion: item.revision.headerVersion + 1, bodyVersion: item.revision.bodyVersion + 1 };
        persisted.set(item.id, { ...item, header: input.header, body: input.body, revision }); return { revision }; },
    };
    const actions = createSkillActionExecuteV1({ store, randomId: () => 'unused', nowMs: () => 1,
      skillRules: { serverId: 'home', assertCurrent() {}, listSkills: async () => [],
        ruleWriteContext: () => ({ nowMs: 1, newId: () => 'unused' }),
        readCatalog: async () => ({ catalog: f.input.accountSnapshot!.promptLibraryCatalog! }),
        writeRecord: async () => { throw new Error('No reach write requested'); } },
      readRegistryItem: registry.readRegistryItem, readRegistrySource: registry.readRegistrySource,
      fetchRegistrySkillFiles: registry.filesForPointer, readLinkSkills: registry.readLinkSkills, fetchLinkSkillFiles: registry.fetchLinkSkillFiles,
      includeInSession: async () => ({ ok: true }) });
    const imported = kind === 'upload' ? { kind, files: sourceFiles.map(file => ({ path: file.path, contentKind: 'utf8', contentBase64: file.bytes.toString('base64') })) }
      : kind === 'link' || kind === 'folder-link' ? { kind: 'link', url: kind === 'folder-link' ? `${source.url}/tree/${commit}/skills/a` : source.url }
        : { kind, sourceId: source.id, itemId: 'a', version: commit };
    const preview = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(await actions('skills.install', { source: imported, dryRun: true }, { surface: 'ui' }));
    expect(preview).toMatchObject({ items: [{ path: `${prefix}a`, outsideReferences: ['../source-b/SKILL.md', '../README.md'],
      siblingSkills: [{ path: `${prefix}source-b` }] }, { path: `${prefix}source-b`, name: declaredName }] });
    if (kind === 'folder-link') {
      const unticked = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(await actions('skills.install', {
        source: imported, dryRun: true, selectPaths: [`${prefix}a`],
      }, { surface: 'ui' }));
      if (!('items' in unticked)) throw new Error('Expected preview');
      expect(unticked.items.map(item => item.path)).toEqual([`${prefix}a`]);
      expect(unticked.items[0]).not.toHaveProperty('siblingSkills');
      expect(unticked.items[0]!.outsideReferences).toContain('../README.md');
    }
    const added = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(await actions('skills.install', {
      source: imported, where: { kind: 'replace', rules: [] }, selectPaths: [`${prefix}a`, `${prefix}source-b`],
    }, { surface: 'ui' }));
    if (!('skillIds' in added)) throw new Error('Expected Add acknowledgement');
    expect(added.skillIds).toHaveLength(2);
    if (kind === 'folder-link') {
      const held = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(await actions('skills.install', { source: imported, dryRun: true }, { surface: 'ui' }));
      if (!('items' in held)) throw new Error('Expected held preview');
      expect(held.items.map(item => item.inLibrary)).toEqual(added.skillIds);
      expect(held.items[0]).not.toHaveProperty('siblingSkills');
      expect(await actions('skills.install', { source: imported }, { surface: 'ui' })).toMatchObject({ skillIds: added.skillIds });
      expect(persisted.size).toBe(2);
    }
    if (rename) expect(await actions('skills.update', { skillId: added.skillIds[1], expectedRevision: '1:1', name: 'renamed-b' }, { surface: 'ui' }))
      .toMatchObject({ revision: '2:2' });
    const artifacts: SkillArtifactStore = { list: async () => { throw new Error('Runner reads selected ids'); },
      read: async id => { const item = persisted.get(id); if (!item) return null;
        if (!item.header) throw new Error('Expected stored header');
        return { ...bundle(id, 'unused'), header: item.header, body: item.body, revision: item.revision }; } };
    const input = { ...f.input, sessionMetadata: { skillSelectionV1: { v: 1, forceIncludeSkillIds: added.skillIds, forceExcludeSkillIds: ['library'] } } };
    const delivered = await resolveRunnerSkills(input, { artifacts, ensureSessionDir: value => f.store.ensureSkillSessionDir(value) });
    expect(delivered.unavailable).toBeUndefined();
    expect(delivered.delivery?.items.map(item => item.name)).toEqual(['a', rename ? 'renamed-b' : declaredName]);
    expect(await readdir(delivered.delivery!.skillsRoot)).toEqual(['a', 'source-b']);
    expect(await readFile(`${delivered.delivery!.skillsRoot}/a/../source-b/SKILL.md`, 'utf8')).toContain(`name: ${rename ? 'renamed-b' : declaredName}`);
    const delivery = delivered.delivery!;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    // Allocate the host's real secure temp directory before emulating Windows copy semantics.
    const shaping = prepareGeminiNativeMcpShaping({ HOME: f.home }, undefined, delivery);
    let shaped: Awaited<typeof shaping>;
    try {
      if (platform) Object.defineProperty(process, 'platform', { value: platform });
      shaped = await shaping;
    } finally { Object.defineProperty(process, 'platform', originalPlatform); }
    try {
      const destination = join(shaped.env.HOME, '.agents', 'skills');
      expect(await readFile(join(destination, 'a', '..', 'source-b', 'SKILL.md'), 'utf8')).toContain(`name: ${rename ? 'renamed-b' : declaredName}`);
      if (platform) expect((await fs.lstat(join(destination, 'source-b'))).isSymbolicLink()).toBe(false);
    } finally { await shaped.cleanup(); }
    expect(resolveHappierSkillIdentity({ path: join(delivery.skillsRoot, 'source-b', 'SKILL.md') }, delivery)).toBe(added.skillIds[1]);
  });
  it('composes the registered Claude launch settings with masking and fails closed after registration retirement', async () => {
    const f = await fixture();
    const extra = join(f.home, 'extra');
    const native = join(extra, '.claude', 'skills', 'sample');
    await mkdir(native, { recursive: true });
    await writeFile(join(native, 'SKILL.md'), '---\nname: sample\n---\nNative');
    const plugin = await createPluginTestkit({ manifest: CLAUDE_PLUGIN.manifest, module: CLAUDE_PLUGIN });
    onTestFinished(() => plugin.dispose());
    const contribution = plugin.registration('agents', 'claude')?.preflightSessionControls;
    expect(contribution).toBeDefined();
    let current = true;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({ agentId: 'claude', preflightSessionControls: contribution!,
      systemTools: [{ id: 'claude-cli', title: 'Claude', executableNames: ['claude'] }],
      retirementSignal: new AbortController().signal, isCurrent: () => current,
      resolvePluginSettings: async () => ({ account: { claudeRemoteAdvancedOptionsJson: JSON.stringify({ additionalDirectories: [extra] }) } }),
    });
    const input = { ...f.input, agentId: 'claude', contributes: { catalogEntriesById: { claude: {
      ...f.input.contributes!.catalogEntriesById.test!, ...projected,
      skills: { delivery: 'session_dir' as const, nativeDisable: 'supported' as const, liveReload: 'supported' as const,
        nativeRoots: { project: [['.claude', 'skills']] } },
    } } } };
    const transports = { artifacts: f.artifacts, ensureSessionDir: (request: Parameters<typeof f.store.ensureSkillSessionDir>[0]) => f.store.ensureSkillSessionDir(request) };
    const masked = await resolveRunnerSkills(input, transports);
    expect(masked.plan.items).toContainEqual(expect.objectContaining({ skillId: 'library', state: 'masked_by_native' }));
    const terminal = await resolveRunnerSkills({ ...input, sessionMetadata: { runtimeDescriptorV1: {
      v: 1, agentId: 'claude', agent: { backendMode: 'unifiedTerminal' },
    } } }, transports);
    expect(terminal.delivery?.items).toContainEqual(expect.objectContaining({ skillId: 'library' }));
    current = false;
    const retired = await resolveRunnerSkills(input, transports);
    expect(retired.unavailable).toBe(true);
    expect(retired.delivery).toBeUndefined();
  });
  it('uses Agent-owned effective launch directories for native masking and disables', async () => {
    const f = await fixture();
    const extra = join(f.home, 'extra');
    const native = join(extra, '.skills', 'sample');
    await mkdir(native, { recursive: true });
    await writeFile(join(native, 'SKILL.md'), '---\nname: sample\n---\nNative extra-directory skill');
    const catalog = { catalogEntriesById: { test: {
      skills: { delivery: 'session_dir' as const, nativeDisable: 'supported' as const, liveReload: 'supported' as const,
        nativeRoots: { project: [['.skills']] } },
      resolveProbePluginSettings: async () => ({ account: { extra } }),
      resolveNativeSkillDirectories: ({ pluginSettings }: { pluginSettings: { account?: Readonly<Record<string, unknown>> } }) =>
        [String(pluginSettings.account?.extra)],
    } } };
    const input = { ...f.input, contributes: catalog };
    const result = await resolveRunnerSkills(input, { artifacts: f.artifacts,
      ensureSessionDir: request => f.store.ensureSkillSessionDir(request) });
    expect(result.plan.items).toContainEqual(expect.objectContaining({ skillId: 'library', state: 'masked_by_native', maskedBy: { path: join(native, 'SKILL.md') } }));
    expect(result.delivery?.items).not.toContainEqual(expect.objectContaining({ skillId: 'library' }));
    const disabled = await resolveRunnerSkills({ ...input, sessionMetadata: { skillSelectionV1: {
      v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: ['sample'],
    } } }, { artifacts: f.artifacts, ensureSessionDir: request => f.store.ensureSkillSessionDir(request) });
    expect(disabled.delivery?.nativeDisables).toEqual([{ name: 'sample', path: join(native, 'SKILL.md') }]);
    expect(disabled.delivery?.items).toContainEqual(expect.objectContaining({ skillId: 'library' }));
  });
  it('delivers readable skills beside unavailable plugin content that is not selected', async () => {
    const f = await fixture();
    const selected = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix', directory: f.directory,
      projectKey: null, agentId: 'test' }, mcp: null, skills: { items: [{ skillId: 'library', name: 'sample' }],
      rules: [{ id: 'on', skillId: 'library', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] },
      selection: {}, agentAcceptsUserMcp: false }).skills;
    const result = await prepareSessionSkillPlan({ inventory: [bundle('library', 'sample')], artifacts: f.artifacts, selected,
      pluginSkills: [{ skillId: 'plugin:external.skills/broken', files: [],
        provenance: { kind: 'plugin', pluginId: 'external.skills', occurrenceId: 'unavailable' } }],
      agentSkills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported' }, agentHasActionChannel: true,
      directory: f.directory, home: f.home, assertCurrent: async () => {} });
    expect(result.plan.items).toContainEqual(expect.objectContaining({ skillId: 'library', state: 'delivered' }));
    const runner = await resolveRunnerSkills({ ...f.input, pluginSkills: [{ skillId: 'plugin:external.skills/broken', files: [],
      provenance: { kind: 'plugin', pluginId: 'external.skills', occurrenceId: 'unavailable' } }] },
    { artifacts: f.artifacts, ensureSessionDir: request => f.store.ensureSkillSessionDir(request) });
    expect(runner.delivery?.items).toContainEqual(expect.objectContaining({ skillId: 'library' }));
  });
  it('delivers plugin library content through the ordinary skill plan and cache', async () => {
    const f = await fixture();
    const skillId = 'plugin:com.acme.skills/check';
    const pluginSkills = [{ skillId, provenance: { kind: 'plugin' as const, pluginId: 'com.acme.skills', occurrenceId: 'occurrence' },
      files: [{ path: 'SKILL.md', contentKind: 'utf8' as const,
        contentBase64: Buffer.from('---\nname: check\ndescription: Check the project\n---\nPlugin instructions').toString('base64') }] }];
    const input = { ...f.input, pluginSkills, sessionMetadata: { skillSelectionV1: {
      v: 1, forceIncludeSkillIds: [skillId], forceExcludeSkillIds: [], excludeNativeSkillNames: [] } } };
    const result = await resolveRunnerSkills(input, { artifacts: f.artifacts,
      ensureSessionDir: request => f.store.ensureSkillSessionDir(request) });
    expect(result.delivery?.items).toContainEqual(expect.objectContaining({ skillId, name: 'check' }));
    expect(await readFile(join(result.delivery!.skillsRoot, 'check', 'SKILL.md'), 'utf8')).toContain('Plugin instructions');
  });
  it('reads independent selected skills concurrently before authenticated folder delivery, preserving conflicts and failures', async () => {
    const f = await fixture();
    const older = { ...bundle('older', 'shared'), updatedAt: 1 };
    const newer = { ...bundle('newer', 'shared'), updatedAt: 2 };
    const broken = bundle('broken', 'broken');
    const off = bundle('off', 'off');
    const started: string[] = [];
    let releasing = false;
    const pending = new Map<string, { resolve: (artifact: AccountArtifact | null) => void; reject: (error: Error) => void }>();
    // Artifact reads are the persistence boundary. Selection, content decoding,
    // native scanning, conflict resolution and daemon materialization stay real.
    const artifacts: SkillArtifactStore = {
      list: async () => ({ items: [older, newer, broken, off], coverage: 'complete' }),
      read: id => {
        if (releasing) return Promise.resolve(null);
        started.push(id);
        return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
      },
    };
    const input = { ...f.input, accountSnapshot: { ...f.input.accountSnapshot!, promptLibraryCatalog: { status: 'ready' as const,
      rows: [{ revision: 1, record: { key: 'skill-rules' as const, value: { v: 1 as const,
        rules: [coreOff, ...['older', 'newer', 'broken', 'off'].map(skillId => ({ id: `on-${skillId}`, skillId,
          target: { t: 'allMachines' as const }, enabled: skillId !== 'off', createdAt: 1, updatedAt: 1 }))],
      } } }], tombstones: [], diagnostics: [] } } };
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'parallel-test', skillStore: f.store });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const work = resolveRunnerSkills(input, { artifacts, ensureSessionDir: content => ensureSkillSessionDirHttp(content,
      { target: { pid: process.pid, httpPort: Number(new URL(url).port), controlToken: 'parallel-test' } }) });
    try {
      await setImmediate();
      expect(started).toEqual(['older', 'newer', 'broken']);
      pending.get('newer')!.resolve(newer);
      pending.get('broken')!.reject(new Error('Artifact transport unavailable'));
      pending.get('older')!.resolve(older);
      const result = await work;
      expect(result.plan.items.filter(item => ['older', 'newer', 'broken', 'off'].includes(item.skillId)))
        .toEqual([
          expect.objectContaining({ skillId: 'older', state: 'name_conflict' }),
          expect.objectContaining({ skillId: 'newer', state: 'delivered', name: 'shared' }),
          expect.objectContaining({ skillId: 'broken', state: 'unavailable', reason: 'content_unreadable' }),
          expect.objectContaining({ skillId: 'off', state: 'off' }),
        ]);
      expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'newer', name: 'shared' })]);
      expect(await readFile(join(result.delivery!.skillsRoot, 'shared', 'SKILL.md'), 'utf8')).toContain('name: shared');
      expect(result.unavailable).toBeUndefined();
      const notices: unknown[] = [];
      // Committed Session event persistence is the external boundary; the
      // real notice owner must identify only the unreadable sibling.
      await publishRunnerSkillNotice({ enqueueSessionEventCommitted: async event => {
        notices.push(event); return { persisted: true as const, delivered: false as const };
      } }, result);
      expect(notices.map(readSessionCapabilityNoticeV1)).toEqual([{ v: 1, items: [
        { kind: 'skill', name: 'broken', itemId: 'broken', code: 'skills_unavailable', detail: 'content_unreadable' },
      ] }]);
    } finally {
      // Also release a serialized implementation after the deciding assertion fails.
      releasing = true;
      for (const read of pending.values()) read.resolve(null);
      await work;
      await app.close();
    }
  });
  it.each(['linux', 'win32'] as const)('reads the predecessor bundle through the catalog and authenticated daemon Session delivery on %s', async platform => {
    const f = await fixture();
    const retainedArtifact = { ...bundle('library', 'retained'), header: retained.header, body: JSON.stringify(retained.body) };
    const healthy = bundle('healthy', 'healthy');
    const legacy = retainedFrontmatter.cases.find(item => item.id === 'unquoted-colon')!;
    const legacyArtifact = { ...bundle('legacy', legacy.expectedName), header: legacy.header, body: JSON.stringify(legacy.body) };
    const artifacts: SkillArtifactStore = { list: async () => ({ items: [retainedArtifact, healthy, legacyArtifact], coverage: 'complete' }),
      read: async id => id === 'library' ? retainedArtifact : id === 'legacy' ? legacyArtifact : healthy };
    const input = { ...f.input, accountSnapshot: { ...f.input.accountSnapshot!, promptLibraryCatalog: { status: 'ready' as const,
      rows: [{ revision: 1, record: { key: 'skill-rules' as const, value: { v: 1 as const, rules: [coreOff, ...['library', 'healthy', 'legacy'].map(skillId => ({
        id: `everywhere-${skillId}`, skillId, target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1,
      }))] } } }], tombstones: [], diagnostics: [] } } };
    const opened = readSkillBundleContentV1(retainedArtifact);
    expect(opened?.frontmatter.name).toBe('retained');
    expect(validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body: PromptBundleBodyV1Schema.parse(retained.body) }))
      .toMatchObject({ ok: false, errorCode: 'invalid_path', path: 'refs/CON.txt' });
    expect(await readSkillLibraryCatalog(artifacts)).toContainEqual({ id: 'library', name: 'retained' });
    expect(await readSkillLibraryCatalog(artifacts)).toContainEqual({ id: 'legacy', name: legacy.expectedName });
    const store = createSkillStore({ happyHomeDir: join(f.home, 'retained-store'), platform }); stores.push(store);
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'retained-test', skillStore: store });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const target = { pid: process.pid, httpPort: Number(new URL(url).port), controlToken: 'retained-test' };
    try {
      const result = await resolveRunnerSkills(input, { artifacts,
        ensureSessionDir: content => ensureSkillSessionDirHttp(content, { target }) });
      if (platform === 'win32') {
        expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'healthy', name: 'healthy' }),
          expect.objectContaining({ skillId: 'legacy', name: legacy.expectedName })]);
        expect(await readFile(join(result.delivery!.skillsRoot, 'healthy', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
        expect(result.plan.items.find(item => item.skillId === 'library')).toMatchObject({ state: 'unavailable', reason: 'materialize_failed' });
        expect(result.failureDetails).toEqual([{ skillId: 'library', detail: 'invalid_path' }]);
      } else {
        expect(result.delivery?.items).toEqual(expect.arrayContaining([{ skillId: 'library', name: 'retained', digest: opened!.digest,
          directory: join(result.delivery!.skillsRoot, 'retained') },
          expect.objectContaining({ skillId: 'healthy', name: 'healthy' }),
          expect.objectContaining({ skillId: 'legacy', name: legacy.expectedName })]));
        expect(await readFile(join(result.delivery!.skillsRoot, 'retained', 'refs', 'CON.txt'), 'utf8')).toBe('Retained supporting bytes');
        expect(AgentRuntimeDaemonSessionOpenRequestV1Schema.parse({ kind: 'create', sessionId: 'session', cwd: f.directory,
          skills: result.delivery }).skills).toEqual(result.delivery);
      }
      expect(await readFile(join(result.delivery!.skillsRoot, legacy.expectedName, 'SKILL.md'), 'utf8')).toBe(legacy.input.skillMarkdown);
    } finally { await app.close(); }
  });
  it.each(['body', 'base64', 'header'] as const)('keeps a malformed stored %s out of the shared name catalog while a valid neighbour remains deliverable', async fault => {
    const f = await fixture();
    const good = bundle('library', 'sample');
    const bad = fault === 'header' ? { ...bundle('bad', 'bad'), header: { ...good.header, title: '' } }
      : { ...bundle('bad', 'bad'), body: fault === 'body' ? '{malformed' : JSON.stringify({ ...retained.body,
        entries: retained.body.entries.map(entry => entry.path === 'SKILL.md' ? { ...entry, contentBase64: '!' } : entry) }) };
    const artifacts: SkillArtifactStore = { list: async () => ({ items: [bad, good], coverage: 'complete' }),
      read: async id => id === 'bad' ? bad : good };
    expect(await readSkillLibraryCatalog(artifacts)).toContainEqual({ id: 'library', name: 'sample' });
    expect(await readSkillLibraryCatalog(artifacts)).not.toContainEqual(expect.objectContaining({ id: 'bad' }));
    const result = await resolveRunnerSkills({ ...f.input, sessionMetadata: {
      skillSelectionV1: { v: 1, forceIncludeSkillIds: ['bad'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
    } }, { artifacts, ensureSessionDir: value => f.store.ensureSkillSessionDir(value) });
    expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library' })]);
    const name = fault === 'header' ? 'bad' : 'Display title';
    expect(result.plan.items.find(item => item.skillId === 'bad')).toMatchObject({ name, state: 'unavailable', reason: 'content_unreadable' });
    const notices: unknown[] = [];
    await publishRunnerSkillNotice({ enqueueSessionEventCommitted: async event => {
      notices.push(event); return { persisted: true as const, delivered: false as const };
    } }, result);
    expect(notices.map(readSessionCapabilityNoticeV1)).toEqual([{ v: 1, items: [
      { kind: 'skill', name, itemId: 'bad', code: 'skills_unavailable', detail: 'content_unreadable' },
    ] }]);
  });
  it('keeps a deleted skill inert on resume and live reapply despite leftover rules and Session selection', async () => {
    const { input, store } = await fixture();
    // Artifact persistence is the boundary; deletion, selection, preparation,
    // materialization and notice publication use their real owning logic.
    const persisted = new Map([['library', bundle('library', 'sample')]]);
    const artifacts: SkillArtifactStore = {
      list: async () => { throw new Error('Runner must read exact demand'); },
      read: async id => persisted.get(id) ?? null,
    };
    const actions = createSkillActionExecuteV1({ randomId: () => 'unused',
      store: {
        list: async () => ({ items: [], coverage: 'complete' }),
        read: async id => { const artifact = persisted.get(id);
          return artifact ? { id, header: artifact.header, body: typeof artifact.body === 'string' ? artifact.body : null,
            owned: true, revision: artifact.revision } : null; },
        create: async () => { throw new Error('No create requested'); },
        update: async () => { throw new Error('No update requested'); },
        delete: async ({ artifactId }) => { persisted.delete(artifactId); },
      },
      skillRules: { serverId: 'home', assertCurrent() {}, listSkills: async () => [],
        ruleWriteContext: () => ({ nowMs: 1, newId: () => 'unused' }),
        readCatalog: async () => ({ catalog: input.accountSnapshot!.promptLibraryCatalog! }),
        writeRecord: async () => { throw new Error('Rules write unavailable'); } },
      includeInSession: async () => ({ ok: true }),
    });
    const selectedInput = { ...input, sessionMetadata: { skillSelectionV1: {
      v: 1, forceIncludeSkillIds: ['library'], forceExcludeSkillIds: [], excludeNativeSkillNames: [],
    } } };
    const transports = { artifacts, ensureSessionDir: (value: Parameters<typeof store.ensureSkillSessionDir>[0]) => store.ensureSkillSessionDir(value) };
    const initial = await resolveRunnerSkills(selectedInput, transports);
    expect(initial.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library' })]);
    expect(await actions('skills.delete', { skillId: 'library', expectedRevision: '1:1' }, { surface: 'ui' }))
      .toEqual({ deleted: true, rulesLeft: true });
    const notices: unknown[] = [];
    for (const lifecycle of ['reapply', 'start'] as const) {
      const result = await resolveRunnerSkills({ ...selectedInput, lifecycle }, transports);
      expect(result.plan.items).not.toContainEqual(expect.objectContaining({ skillId: 'library' }));
      expect(result.unavailable).toBeUndefined();
      expect(result.delivery?.items ?? []).toEqual([]);
      await publishRunnerSkillNotice({ enqueueSessionEventCommitted: async event => {
        notices.push(event); return { persisted: true as const, delivered: false as const };
      } }, result);
    }
    expect(await readdir(initial.delivery!.skillsRoot)).toEqual([]);
    expect(notices).toEqual([]);
  });
  it('uses the same realpath preparation as MCP for linked workspace roots without matching a sibling prefix', async () => {
    const { input, artifacts, store, home, directory } = await fixture();
    const linked = join(home, 'linked');
    await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const skills = { items: [{ skillId: 'library', name: 'sample' }], rules: [{ id: 'folder', skillId: 'library',
      target: { t: 'workspace' as const, machineId: 'machine', workspaceRoot: linked }, enabled: true, createdAt: 1, updatedAt: 1 }] };
    const accountSnapshot = { ...input.accountSnapshot!, promptLibraryCatalog: { status: 'ready' as const,
      rows: [{ revision: 2 as const, record: { key: 'skill-rules' as const, value: { v: 1 as const, rules: [coreOff, ...skills.rules] } } }], tombstones: [], diagnostics: [] } };
    const { resolveSessionCapabilitiesForDirectory } = await import('@/mcp/servers/resolveSessionCapabilitiesForDirectory');
    const mcp = { v: 1 as const, strictMode: false, servers: [{ id: 'server', name: 'server', transport: 'http' as const,
      remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: skills.rules.map(rule => ({ ...rule, serverId: 'server' })) };
    const preview = resolveSessionCapabilitiesForDirectory({ settings: mcp, skills, machineId: 'machine', directory, agentAcceptsUserMcp: true });
    expect(preview.mcp.items[0]).toMatchObject({ selected: true, reason: 'rule_on' });
    expect(preview.skills.items[0]).toMatchObject({ selected: true, reason: 'rule_on' });
    const resolved = await resolveRunnerSkills({ ...input, accountSnapshot }, { artifacts, ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(resolved.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library' })]);
    const sibling = `${directory}2`; await mkdir(sibling);
    const adjacent = await resolveRunnerSkills({ ...input, directory: sibling, accountSnapshot }, { artifacts, ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(adjacent.delivery).toBeUndefined();
    expect(skills.rules[0]!.target.workspaceRoot).toBe(linked);
  });
  it.each(['rule', 'session'] as const)('delivers selected skill references without opening the unrelated Account inventory (%s demand)', async demand => {
    const { input, artifacts, store, readIds } = await fixture();
    const selectedInput = { ...input, sessionMetadata: { skillSelectionV1: {
      v: 1, forceIncludeSkillIds: demand === 'session' ? ['library', 'excluded'] : ['excluded'],
      forceExcludeSkillIds: ['excluded'], excludeNativeSkillNames: [],
    } }, ...(demand === 'session' ? { accountSnapshot: { ...input.accountSnapshot!, promptLibraryCatalog: { status: 'ready' as const,
      rows: [{ revision: 1, record: { key: 'skill-rules' as const, value: { v: 1 as const, rules: [coreOff] } } }],
      tombstones: [], diagnostics: [] } } } : {}) };
    const result = await resolveRunnerSkills(selectedInput, { artifacts: { ...artifacts,
      list: async () => { throw new Error('Unrelated Account inventory unavailable'); } },
      ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library', name: 'sample' })]);
    expect(readIds).toEqual(['library']);
    expect(result.indexItems).toEqual([]);
    expect(await readFile(join(result.delivery!.skillsRoot, 'sample', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
    const request = { kind: 'create' as const, sessionId: input.ownerKey, cwd: input.directory, skills: result.delivery };
    expect(AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request).skills).toEqual(result.delivery);
    expect(AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema.parse(
      projectAgentRuntimeDaemonSessionOpenAttestationRequestV1(request),
    )).toEqual({ kind: 'create', sessionId: input.ownerKey, cwd: input.directory });
  });
  it('keeps the session startable and marks daemon failure visibly', async () => {
    const { input, artifacts } = await fixture();
    const result = await resolveRunnerSkills(input, { artifacts, ensureSessionDir: async () => { throw new Error('daemon_unreachable'); } });
    expect(result.delivery).toBeUndefined();
    expect(result.unavailable).toBe(true);
    expect(result.plan.items[0]).toMatchObject({ state: 'unavailable', reason: 'materialize_failed' });
    expect(result.unavailableReason).toBe('materialize_failed');
  });
  it('retains a failed skill-rules read as the reason even before item resolution', async () => {
    const { input, artifacts } = await fixture();
    const result = await resolveRunnerSkills({ ...input, accountSnapshot: { ...input.accountSnapshot!,
      promptLibraryCatalog: { status: 'unavailable', reason: 'invalid-stored-content' },
    } }, { artifacts });
    expect(result).toMatchObject({ unavailable: true, unavailableReason: 'invalid-stored-content' });
    expect(result.delivery).toBeUndefined();
  });
  it('still delivers readable selected skills at startup when another selected body is unavailable', async () => {
    const { input, artifacts, store } = await fixture();
    const unavailable = bundle('unavailable', 'missing');
    const result = await resolveRunnerSkills({ ...input, sessionMetadata: {
      skillSelectionV1: { v: 1, forceIncludeSkillIds: ['unavailable'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
    } }, { artifacts: {
      list: async () => ({ items: [...(await artifacts.list()).items, unavailable], coverage: 'complete' }),
      read: async id => { if (id === 'unavailable') throw new Error('body_unavailable'); return artifacts.read(id); },
    }, ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library', name: 'sample' })]);
    expect(result.plan.items.find(item => item.skillId === 'unavailable')).toMatchObject({ state: 'unavailable', reason: 'content_unreadable' });
    expect(await readFile(join(result.delivery!.skillsRoot, 'sample', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
  });
  it('retains the daemon filesystem failure code without disclosing a partial skill', async () => {
    const { input, artifacts } = await fixture();
    const result = await resolveRunnerSkills(input, { artifacts, ensureSessionDir: async () => ({
      pluginRoot: '/session', skillsRoot: '/session/skills', items: [], failed: [{ skillId: 'library', reason: 'materialize_failed', detail: 'EACCES' }],
    }) });
    expect(result.delivery?.items).toEqual([]);
    expect(result.failureDetails).toEqual([{ skillId: 'library', detail: 'EACCES' }]);
    expect(AgentRuntimeDaemonSessionOpenRequestV1Schema.parse({
      kind: 'resume', sessionId: input.ownerKey, cwd: input.directory, providerSessionId: 'native-session', skills: result.delivery,
    }).skills).toEqual(result.delivery);
  });
  it('withholds uncertain native masking after a failed root and never asks the daemon to deliver', async () => {
    const { input, artifacts } = await fixture();
    await writeFile(join(input.home!, '.native'), 'This root is a file');
    const result = await resolveRunnerSkills({ ...input, contributes: { catalogEntriesById: { test: {
      skills: { ...input.contributes!.catalogEntriesById.test!.skills!, nativeRoots: { user: [['.native']] } },
    } } } }, { artifacts, ensureSessionDir: async () => { throw new Error('must_not_deliver'); } });
    expect(result.plan.items[0]).toMatchObject({ state: 'unavailable', reason: 'native_scan_failed' });
    expect(result.plan.diagnostics).toHaveLength(1);
  });
  it('requires Account credentials but delivers known demand independently of partial inventory', async () => {
    const { input, artifacts, store } = await fixture();
    const scoped = await resolveRunnerSkills({ ...input, credentials: null }, { artifacts: { ...artifacts, list: async () => { throw new Error('must_not_read'); } } });
    expect(scoped.delivery).toBeUndefined();
    const resolved = await resolveRunnerSkills(input, { artifacts: { ...artifacts, list: async () => ({ items: [], coverage: 'partial' }) },
      ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(resolved.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library', name: 'sample' })]);
  });
  it('serves an index without materializing a folder and without embedding skill bodies', async () => {
    const { input, artifacts } = await fixture();
    const result = await resolveRunnerSkills({ ...input, contributes: { catalogEntriesById: {} } }, { artifacts });
    expect(result.plan.plan).toBe('index');
    expect(result.indexItems).toEqual([expect.objectContaining({ skillId: 'library', name: 'sample', description: 'Useful' })]);
    expect(result.delivery).toBeUndefined();
  });
});
