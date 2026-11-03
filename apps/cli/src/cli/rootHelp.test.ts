import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { projectPluginCommandDeclarations } from './pluginCommandDeclarations';

import { BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { resolvePluginStorePathLayout } from '@/plugins/store/pathLayout';
import { loadAdmittedInstalledPluginDeclarations } from '@/plugins/discovery/load/admitted';
import { loadPluginsFromState } from '@/plugins/discovery/load/installed';
import { readAdmittedPluginRegistryState } from '@/plugins/store/registry/admittedState';
import { stateRevisionPath } from '@/plugins/store/registry/installationStateRevisionFile';
import { ensureMergedAgentCommandRegistryLoaded, findCommandDispatchDescriptor, listRegisteredCommandSurfaceEntries, resolveCommandCompletionCandidates } from './commandRegistry';
import { projectBundledRootHelpEntries, resolveRootHelpEntries, resolveReadOnlyCommandCompletionDeclarations } from './rootHelp';
import { renderRootHelpText } from './rootHelpText';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'happier-root-help-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('root help declaration projection', () => {
  it('renders the exact same bytes as real bundled executable registration', async () => {
    const happyHomeDir = await temporaryDirectory();
    await ensureMergedAgentCommandRegistryLoaded({ happyHomeDir });
    expect(findCommandDispatchDescriptor('auth')?.handler).toBeTypeOf('function');
    expect(renderRootHelpText(projectBundledRootHelpEntries(BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA)))
      .toBe(renderRootHelpText(listRegisteredCommandSurfaceEntries()));
  });

  it('uses the same Agent root reservations and collision admission', () => {
    const entries = projectBundledRootHelpEntries([{
      pluginId: 'acme.agents',
      agents: [
        { id: 'reserved-static', cliSubcommand: 'auth', title: 'Wrong auth owner' },
        { id: 'reserved-action', cliSubcommand: 'teams', title: 'Wrong Teams owner' },
        { id: 'duplicate-a', cliSubcommand: 'duplicated', title: 'Wrong duplicate A' },
        { id: 'duplicate-b', cliSubcommand: 'duplicated', title: 'Wrong duplicate B' },
        { id: 'codex', cliSubcommand: 'codex', title: 'Declared Codex title' },
      ],
      actions: [],
    }]);
    expect(entries.find((entry) => entry.command === 'auth')?.rootHelpDescription).toBe('Manage authentication');
    expect(entries.find((entry) => entry.command === 'teams')?.rootHelpDescription).toBe('Manage Teams, members, and Team policy');
    expect(entries.find((entry) => entry.command === 'duplicated')).toBeUndefined();
    expect(entries.find((entry) => entry.command === 'codex')?.rootHelpDescription).toBe('Start Declared Codex title');
  });

  it('lists admitted bundled plugin commands and fences unavailable or conflicting paths', () => {
    const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
      id: 'acme.bundled-help',
      contributes: { actions: [{ scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object' }, id: 'read-command', title: 'Read', description: 'Read a bundled note', cli: { path: ['bundled-notes', 'read'] } },
{ scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object' }, id: 'reserved', title: 'Wrong auth', cli: { path: ['auth', 'replacement'] } },
{ scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object' }, id: 'unavailable', title: 'Unavailable', availability: {
            when: { fact: 'host.feature', operator: 'enabled', value: 'missing-default-fact' },
          }, cli: { path: ['unknown-facts', 'read'] } },
{ scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object' }, id: 'duplicate-a', title: 'Duplicate', cli: { path: ['conflicted', 'read'] } },
{ scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object' }, id: 'duplicate-b', title: 'Duplicate', cli: { path: ['conflicted', 'read'] } } ] },
    }));
    const entries = projectBundledRootHelpEntries([projectPluginCommandDeclarations({ manifest, provenance: 'first_party', source: { kind: 'bundled' } })]);
    expect(entries.find((entry) => entry.command === 'bundled-notes')).toMatchObject({ rootHelpDescription: 'Read a bundled note' });
    expect(entries.find((entry) => entry.command === 'auth')).toMatchObject({ rootHelpDescription: 'Manage authentication' });
    expect(entries.find((entry) => entry.command === 'unknown-facts')?.rootHelpLabel).toBeUndefined();
    expect(entries.find((entry) => entry.command === 'conflicted')?.rootHelpLabel).toBeUndefined();
  });

  it('uses accepted installed declarations and freshly reads a replacement', async () => {
    const happyHomeDir = await temporaryDirectory();
    const pluginRoot = await temporaryDirectory();
    const pluginId = 'acme.root-help';
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
      id: pluginId,
      contributes: { agents: [{
          id: 'scribe', title: 'Acme Scribe', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          cli: {
            executable: { binaryName: 'scribe', sourcePreference: 'system-first', acceptsJavaScriptFileOverride: false },
            install: { manual: { kind: 'none' } },
            auth: { support: 'login_terminal', loginLaunches: [{ kind: 'primary', args: ['login'] }] },
          },
        }],
actions: [{ scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['brief', 'full'] } } }, id: 'read-command', title: 'Read note', description: 'Read an installed note', cli: { path: ['installed-notes', 'read'] } } ] },
    }));
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const source = await resolveLocalPathPluginSource({ locator: pluginRoot });
    if (!source.ok) throw new Error(`Invalid installed help fixture: ${JSON.stringify(source.diagnostics)}`);
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: manifest.version, devWatch: true });
    await ensureMergedAgentCommandRegistryLoaded({ happyHomeDir });
    expect(renderRootHelpText(await resolveRootHelpEntries(happyHomeDir)))
      .toBe(renderRootHelpText(listRegisteredCommandSurfaceEntries()));
    expect((await resolveRootHelpEntries(happyHomeDir)).find((entry) => entry.command === 'installed-notes'))
      .toMatchObject({ rootHelpDescription: 'Read an installed note' });
    expect((await resolveRootHelpEntries(happyHomeDir)).find((entry) => entry.command === 'acme.root-help/scribe'))
      .toMatchObject({ rootHelpDescription: 'Start Acme Scribe' });
    for (const words of [['installed-notes', 'r'], ['installed-notes', 'read', '--'], ['installed-notes', 'read', '--format', 'b']]) {
      expect(await resolveCommandCompletionCandidates(words, {
        declarations: await resolveReadOnlyCommandCompletionDeclarations(happyHomeDir, words),
      })).toEqual(await resolveCommandCompletionCandidates(words));
    }
    const { resolveAdmittedAgentListingContributions } = await import('@/plugins/projection/registry/admittedAgents');
    const { resolveMergedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const admittedAgents = await resolveAdmittedAgentListingContributions(happyHomeDir);
    const executableAgents = await resolveMergedContributionRegistry({ happyHomeDir });
    const listingFields = (agents: typeof admittedAgents.agents) => agents.map((agent) => ({
      id: agent.id, identity: agent.identity, runtimeSpec: agent.runtimeSpec, title: agent.richDefinition?.definition.title,
    })).sort((left, right) => left.id.localeCompare(right.id));
    expect(listingFields(admittedAgents.agents)).toEqual(listingFields(executableAgents.agents));

    await writeFile(manifestPath, JSON.stringify({ ...manifest, contributes: { ...manifest.contributes, actions: [{
      ...manifest.contributes.actions![0], title: 'Changed without approval', description: 'Read an accepted replacement note',
    }] } }));
    expect((await resolveRootHelpEntries(happyHomeDir)).find((entry) => entry.command === 'installed-notes'))
      .toMatchObject({ rootHelpDescription: 'Read an installed note' });
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: manifest.version, devWatch: true, replaceExisting: true });
    expect((await resolveRootHelpEntries(happyHomeDir)).find((entry) => entry.command === 'installed-notes'))
      .toMatchObject({ rootHelpDescription: 'Read an accepted replacement note' });
  });

  it('preserves the canonical installed authority failure instead of showing bundled fallback', async () => {
    const happyHomeDir = await temporaryDirectory();
    const paths = resolvePluginStorePathLayout(happyHomeDir);
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCurrentFilePath, '{"schemaVersion":999}');
    await expect(resolveRootHelpEntries(happyHomeDir)).rejects.toMatchObject({
      name: 'PluginRegistryCommitRecordInvalidError',
    });
  });

  it('does not reconstruct missing admitted declarations from a live installed manifest', async () => {
    const happyHomeDir = await temporaryDirectory();
    const pluginRoot = await temporaryDirectory();
    const pluginId = 'acme.unadmitted-help';
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
      id: pluginId,
      contributes: { actions: [{ scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object' }, id: 'read-command', title: 'Unaccepted live command', cli: { path: ['unaccepted-live', 'read'] } } ] },
    }));
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n');
    await writeFile(manifestPath, JSON.stringify(manifest));
    // This supported v1 row has installation identity but no accepted manifest.
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: manifest.version });
    expect((await resolveRootHelpEntries(happyHomeDir)).find((entry) => entry.command === 'unaccepted-live')).toBeUndefined();
    const admitted = await loadAdmittedInstalledPluginDeclarations(happyHomeDir);
    expect(admitted.state.plugins[pluginId]?.install.manifestVersion).toBe(manifest.version);
    expect(admitted.loadedPlugins).toEqual([]);
    expect(admitted.diagnosticsByPluginId[pluginId]).toEqual([expect.objectContaining({ code: 'plugin_manifest_missing' })]);

    // The executable discovery path still validates its physical manifest.
    expect((await loadPluginsFromState(admitted.state)).loadedPlugins).toHaveLength(1);
    await writeFile(admitted.state.plugins[pluginId]!.source.manifestPath, '{invalid');
    const executable = await loadPluginsFromState(admitted.state);
    expect(executable.loadedPlugins).toEqual([]);
    expect(executable.diagnosticsByPluginId[pluginId]?.length).toBeGreaterThan(0);
  });

  it('fails closed on malformed or unsupported admitted revision framing', async () => {
    const happyHomeDir = await temporaryDirectory();
    const paths = resolvePluginStorePathLayout(happyHomeDir);
    const { createPluginRegistryStateStore } = await import('@/plugins/store/registry/currentState');
    await createPluginRegistryStateStore({ happyHomeDir }).initialize();
    const current = await readAdmittedPluginRegistryState(paths);
    if (!current) throw new Error('Registry fixture did not publish admitted state');
    const filePath = stateRevisionPath(paths, current.commit.installationState.revisionId);
    const original = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    for (const invalid of ['{invalid', JSON.stringify({ ...original, schemaVersion: 2 }), JSON.stringify({ ...original, revisionId: 'other-revision' })]) {
      await writeFile(filePath, invalid);
      await expect(resolveRootHelpEntries(happyHomeDir)).rejects.toThrow('Invalid installation state revision');
    }
    await writeFile(filePath, JSON.stringify({ ...original, runtimeCatalog: undefined }));
    await expect(resolveRootHelpEntries(happyHomeDir)).rejects.toThrow('no canonical runtime catalog');
  });

  it('preserves the canonical collision with an installed bundled plugin identity', async () => {
    const happyHomeDir = await temporaryDirectory();
    const pluginRoot = await temporaryDirectory();
    const pluginId = BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA[0]!.pluginId;
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({ id: pluginId }));
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: manifest.version, devWatch: true });
    await expect(ensureMergedAgentCommandRegistryLoaded({ happyHomeDir })).rejects.toThrow(`Duplicate plugin identity '${pluginId}'`);
    await expect(resolveRootHelpEntries(happyHomeDir)).rejects.toThrow(`Duplicate plugin identity '${pluginId}'`);
  });
});
