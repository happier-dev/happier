import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createPromptBundleInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { SkillRulesActionPortV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import type { ActionCliExecutionDeps } from './executeCommand';
import { tryHandleSkillsCliCommand } from './skillsNameArgAdapter';
import { createRegistryHostV1, RegistryProvenanceV1Schema, type RegistryHttpV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { createRegistryUpdateCheck } from '@/registries/updates/registryUpdateTracker';
import { createSkillsUpdateTracker } from '@/registries/updates/trackers/skillsUpdateTracker';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

async function fixture(options: Readonly<{ names?: readonly string[]; unavailable?: boolean; changed?: 'account' | 'home'; ambiguousFound?: boolean }> = {}) {
  const artifacts = new Map<string, PromptLibraryStoredArtifact>();
  // Artifact/row persistence, credentials, and machine RPC are the system boundaries.
  // The library projection, name adapter, compiler, binder, and Action admission stay real.
  const store: PromptLibraryArtifactStore = {
    list: async () => options.unavailable ? { coverage: 'unavailable', items: [] }
      : { coverage: 'complete', items: [...artifacts.values()].map(item => ({ id: item.id, header: item.header, updatedAtMs: 1, owned: true })) },
    read: async id => artifacts.get(id) ?? null,
    readHeadersByIds: async ids => ids.map(id => ({ status: 'fulfilled' as const, value: artifacts.get(id) ?? null })),
    create: async input => { const id = `skill-${artifacts.size + 1}`;
      artifacts.set(id, { id, ...input, owned: true, revision: { headerVersion: 1, bodyVersion: 1 } }); return id; },
    update: async input => {
      const current = artifacts.get(input.artifactId);
      if (!current) throw new Error('Unknown Artifact');
      expect(input.expectedRevision).toEqual(current.revision);
      const revision = { headerVersion: current.revision.headerVersion + 1, bodyVersion: current.revision.bodyVersion + 1 };
      artifacts.set(input.artifactId, { ...current, header: input.header, body: input.body, revision });
      return { revision };
    },
    delete: async () => { throw new Error('Unexpected Artifact deletion'); },
  };
  for (const name of options.names ?? ['review', 'skill-1']) {
    await createPromptBundleInLibrary({ store, request: { title: name, bundleSchemaId: 'skills.skill_md_v1',
      entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${name}\ndescription: Review changes\n---\nRead the patch.`).toString('base64') }] } });
  }
  const skillRules: SkillRulesActionPortV1 = {
    serverId: 'selected-home', assertCurrent() {}, ruleWriteContext: () => ({ nowMs: 1, newId: () => 'rule' }),
    listSkills: async () => [],
    readCatalog: async () => ({ catalog: { status: 'ready', rows: [
      { record: { key: 'skill-rules', value: { v: 1, rules: [] } }, revision: 1 },
      { record: { key: 'skill-usage', value: { v: 1, lastUsedAt: {} } }, revision: 1 },
    ], tombstones: [], diagnostics: [] } }),
    writeRecord: async () => { throw new Error('Unexpected rules mutation'); },
  };
  const found = SkillFoundListResultV1Schema.parse({ scannedAt: 1, roots: [], items: [
    { name: 'native-review', description: null, path: '/native/review', digest: 'sha256:review', agents: ['claude'], scope: 'plugin',
      inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: { pluginName: 'example' } },
    { name: 'native-secondary', description: null, path: '/native/secondary', digest: 'sha256:secondary', agents: ['codex'], scope: 'user',
      inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null },
    ...(options.ambiguousFound ? [{ name: 'native-review', description: null, path: '/native/other', digest: 'sha256:other', agents: ['codex'], scope: 'user',
      inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null }] : []),
  ] });
  const nativeFiles = [{ path: 'SKILL.md', contentKind: 'utf8' as const,
    contentBase64: Buffer.from('---\nname: native-review\n---\nReview native changes.').toString('base64'), unixMode: 0o644 },
    { path: 'scripts/check.sh', contentKind: 'utf8' as const, contentBase64: 'eA==', unixMode: 0o755 }];
  const nativeReads: Array<{ machineId: string; path: string }> = [];
  const library = createSkillActionExecuteV1({ store, skillRules, randomId: () => 'rule',
    readFoundSkillBundle: async (machineId, path) => { nativeReads.push({ machineId, path });
      const item = found.items.find(item => item.path === path); if (!item) throw new Error('Unknown native path');
      return { name: item.name, path: item.path, agents: item.agents, pluginOwned: item.pluginOwned,
        files: nativeFiles.map(file => file.path === 'SKILL.md' ? { ...file,
          contentBase64: Buffer.from(`---\nname: ${item.name}\n---\nReview native changes.`).toString('base64') } : file) }; },
    includeInSession: async () => { throw new Error('Unexpected Session mutation'); } });
  const machineRequests: Array<Readonly<{ actionId: string; input: unknown; context: ActionExecutorContext }>> = [];
  const source: RegistrySourceDescriptorV1 = { id: 'skills-source', title: 'Skills', url: 'https://github.com/a/b', format: 'git',
    kinds: ['skill'], enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
  for (const [id, artifact] of artifacts) artifacts.set(id, { ...artifact, header: { ...artifact.header, skillLock: { updatePolicy: 'manual',
    provenance: { kind: 'registry', registry: RegistryProvenanceV1Schema.parse({ sourceId: source.id, sourceUrl: source.url, format: 'git', itemId: id,
      importedAt: 1, ref: { kind: 'gitTree', repo: source.url, path: id, commit: '1'.repeat(40), treeSha: 'tree' } }) } } } });
  const http: RegistryHttpV1 = { getJson: async () => ({ ok: false, status: { state: 'rate_limited' } }),
    getText: async () => { throw new Error('Rate-limited source cannot read bytes'); }, getBytes: async () => { throw new Error('Rate-limited source cannot read bytes'); } };
  const checker = createRegistryUpdateCheck({ trackers: [createSkillsUpdateTracker({ execute: library })], ctx: { http }, readSources: async () => [source] });
  const registry = createRegistryHostV1({ host: 'node', http, readSources: async () => [source], updates: checker.checkNow });
  const ports = {
    registryActionExecute: ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['registryActionExecute']>>[0]) => registry.execute(actionId, input),
    skillActionExecute: async ({ actionId, input, context }: Parameters<NonNullable<ActionExecutorDeps['skillActionExecute']>>[0]) =>
      library(actionId, input, { surface: context.surface ?? null }, context.signal),
    skillMachineActionExecute: async (request: Parameters<NonNullable<ActionExecutorDeps['skillMachineActionExecute']>>[0]) => {
      machineRequests.push(request);
      if (request.actionId === 'skills.found.list') return found;
      return request.actionId === 'skills.machine.install'
        ? { receipts: [{ root: '/skills', path: '/skills/review', digest: 'sha256:review' }] }
        : { removed: ['/skills/review'] };
    },
    readActionsSettings: () => normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
        'skills.machine.install': ['cli'], 'skills.machine.uninstall': ['cli'],
        'skills.found.adopt': ['cli'],
      } }),
  } satisfies Partial<ActionExecutorDeps>;
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...ports });
  const captured: Array<Parameters<ActionCliExecutionDeps['createExecutorFn']>[0]> = [];
  let credentialReads = 0, profileReads = 0;
  const deps = {
    readCredentialsFn: async () => { throw new Error('Unexpected ambient Account'); },
    readCredentialsForServerIdFn: async () => ({ token: options.changed === 'account' && credentialReads++ > 0 ? 'changed-token' : 'selected-token', encryption: null }),
    getServerProfileFn: async () => ({ id: 'selected-home', name: 'Selected Home',
      serverUrl: options.changed === 'home' && profileReads++ > 0 ? 'https://changed.example.test' : 'https://selected.example.test',
      webappUrl: 'https://selected.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 }),
    createExecutorFn: async input => { captured.push(input); return { ...executor,
      async resolveSessionTarget(): Promise<never> { throw new Error('Unexpected Session target'); } }; },
  } satisfies Partial<ActionCliExecutionDeps>;
  return { run: (argv: readonly string[]) => tryHandleSkillsCliCommand({ argv, actionExecutionDeps: deps }), machineRequests, captured, artifacts, nativeReads };
}

describe('Skills machine CLI name resolution', () => {
  it('resolves Check now names and exact ids through the same library and one registered checker', async () => {
    const owner = await fixture(), output = captureConsoleJsonOutput<unknown>();
    try {
      expect(await owner.run(['skills', 'updates', 'check', 'review', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(output.json(), JSON.stringify(output.json())).toMatchObject({ ok: true, data: { results: [{ kind: 'skill', key: 'skill-1', upstream: { state: 'unchecked' } }] } });
      expect(await owner.run(['skills', 'updates', 'check', 'skill-2', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(output.json()).toMatchObject({ ok: true, data: { results: [{ key: 'skill-2' }] } });
      expect(owner.machineRequests).toEqual([]);
    } finally { output.restore(); }
  });
  it('compiles Found names into scanner paths and adopts Off through the admitted library operation', async () => {
    const owner = await fixture(), output = captureConsoleJsonOutput<unknown>();
    try {
      expect(await owner.run(['skills', 'found', 'show', 'native-review', '--machine', 'selected-machine', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(output.json()).toMatchObject({ ok: true, data: { name: 'native-review', files: [{ path: 'SKILL.md' }, { path: 'scripts/check.sh', unixMode: 0o755 }] } });
      expect(owner.artifacts.size).toBe(2);
      expect(await owner.run(['skills', 'adopt', 'native-review', 'native-secondary', '--machine', 'selected-machine', '--off', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(output.json()).toMatchObject({ ok: true, data: { skillIds: ['skill-3', 'skill-4'], includedInSessionId: null } });
      expect(owner.nativeReads).toEqual([{ machineId: 'selected-machine', path: '/native/review' }, { machineId: 'selected-machine', path: '/native/review' }, { machineId: 'selected-machine', path: '/native/secondary' }]);
      expect(owner.artifacts.get('skill-3')?.header).toMatchObject({ skillLock: { provenance: { kind: 'machine', machineId: 'selected-machine', path: '/native/review', agentIds: ['claude'] } } });
      expect(JSON.parse(owner.artifacts.get('skill-3')!.body!).entries).toContainEqual(expect.objectContaining({ path: 'scripts/check.sh', unixMode: 0o755 }));
      expect(owner.machineRequests).toMatchObject([{ actionId: 'skills.found.list', input: { machineId: 'selected-machine' } }, { actionId: 'skills.found.list', input: { machineId: 'selected-machine' } }]);
    } finally { output.restore(); }
  });
  it('refuses ambiguous Found names before downloading or creating and accepts an exact scanner path', async () => {
    const owner = await fixture({ ambiguousFound: true }), output = captureConsoleJsonOutput<unknown>();
    try {
      await expect(owner.run(['skills', 'adopt', 'native-review', '--machine', 'selected-machine', '--off', '--server-id', 'selected-home']))
        .rejects.toMatchObject({ code: 'ambiguous_skill_name' });
      expect(owner.nativeReads).toEqual([]); expect(owner.artifacts.size).toBe(2);
      expect(await owner.run(['skills', 'found', 'show', '/native/review', '--machine', 'selected-machine', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(owner.nativeReads).toEqual([{ machineId: 'selected-machine', path: '/native/review' }]);
    } finally { output.restore(); }
  });
  it('resolves library names and exact ids while retaining the semantic machine and repeated agents', async () => {
    const owner = await fixture(), output = captureConsoleJsonOutput<unknown>();
    try {
      expect(await owner.run(['skills', 'machine-install', 'review', '--machine', 'selected-machine', '--agent', 'claude', '--agent', 'codex', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(output.json()).toMatchObject({ ok: true, data: { receipts: [{ path: '/skills/review' }] } });
      expect(await owner.run(['skills', 'machine-uninstall', 'skill-1', '--machine=selected-machine', '--force', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(output.json()).toMatchObject({ ok: true, data: { removed: ['/skills/review'] } });
      expect(owner.machineRequests).toMatchObject([
        { actionId: 'skills.machine.install', input: { skillId: 'skill-1', machineId: 'selected-machine', agents: ['claude', 'codex'] }, context: { serverId: 'selected-home' } },
        { actionId: 'skills.machine.uninstall', input: { skillId: 'skill-1', machineId: 'selected-machine', force: true }, context: { serverId: 'selected-home' } },
      ]);
      for (const target of owner.captured) expect(target).toMatchObject({ credentials: { token: 'selected-token' }, serverId: 'selected-home', serverApiUrl: 'https://selected.example.test' });
    } finally { output.restore(); }
  });

  it('refuses ambiguous names before issuing a machine mutation', async () => {
    const owner = await fixture({ names: ['review', 'review'] });
    await expect(owner.run(['skills', 'machine-install', 'review', '--machine', 'selected-machine', '--server-id', 'selected-home']))
      .rejects.toMatchObject({ code: 'ambiguous_skill_name' });
    expect(owner.machineRequests).toEqual([]);
  });

  it.each(['account', 'home'] as const)('refuses a changed captured %s before the machine mutation', async changed => {
    const owner = await fixture({ changed }), output = captureConsoleJsonOutput<unknown>();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await owner.run(['skills', 'machine-install', 'review', '--machine', 'selected-machine', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(owner.machineRequests).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally { output.restore(); }
  });

  it('preserves library unavailability without issuing a machine mutation', async () => {
    const owner = await fixture({ unavailable: true }), output = captureConsoleJsonOutput<unknown>();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await owner.run(['skills', 'machine-uninstall', 'review', '--machine', 'selected-machine', '--server-id', 'selected-home', '--json'])).toBe(true);
      expect(owner.machineRequests).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally { output.restore(); }
  });
});
