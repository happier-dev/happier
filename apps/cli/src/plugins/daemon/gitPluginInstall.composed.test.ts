import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createRegistryHostV1 } from '@happier-dev/protocol/registries';
import { InstalledPluginCapabilityEntryV1Schema } from '@happier-dev/protocol/capabilities/pluginMarketplace';

import { runScmCommand } from '@/scm/runtime';
import { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createMarketplaceIndexService } from '@/plugins/store/marketplace/service';
import { createRegistryUpdateCheck } from '@/registries/updates/registryUpdateTracker';
import { createPluginRegistryUpdateTracker } from '@/registries/updates/trackers/pluginUpdateTracker';
import { createDaemonPluginChangeService } from './changeService';
import { createDaemonPathPluginChangePreparer } from './pathChangePreparer';
import { resolveInstalledPluginUpdate } from './resolveInstalledUpdate';

const { releaseFetch } = vi.hoisted(() => ({ releaseFetch: vi.fn(async () => Response.json({ tag_name: 'v1.2.0' })) }));
vi.mock('@happier-dev/release-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('@happier-dev/release-runtime')>();
  return { ...runtime, fetchGitHubLatestRelease: (params: Parameters<typeof runtime.fetchGitHubLatestRelease>[0]) =>
    runtime.fetchGitHubLatestRelease({ ...params, fetchImpl: releaseFetch }) };
});

describe('Git vendor plugin installation', () => {
  it.each(['catalog', 'direct'] as const)('installs from %s using the selected source channel', async (mode) => {
    releaseFetch.mockClear();
    const root = await mkdtemp(join(tmpdir(), 'happier-git-plugin-test-'));
    const repo = join(root, 'repo');
    const happyHomeDir = join(root, 'home');
    const locator = 'https://github.com/example/vendor-plugin';
    const pluginRoot = join(repo, 'plugins', 'kit');
    const run = async (args: string[]) => {
      const result = await runScmCommand({ bin: 'git', cwd: repo, args });
      if (!result.success) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    let catalogRef: string;
    const getJson = vi.fn(async () => ({ ok: true as const, fetchedAt: 1,
      value: { plugins: [{ name: 'kit', source: { source: 'git-subdir', url: locator, path: 'plugins/kit', ref: catalogRef } }] } }));
    const unavailable = async () => ({ ok: false as const, status: { state: 'invalid_source' as const } });
    const http = { getJson, getText: unavailable, getBytes: unavailable };
    const readSources: Parameters<typeof createRegistryHostV1>[0]['readSources'] = async () => [{
      id: 'vendor', title: 'Vendor', format: 'claude-marketplace', kinds: ['plugin'],
      url: 'https://example.com/marketplace.json', enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true,
    }];
    const registry = createRegistryHostV1({ host: 'node', http, readSources });
    const { readGitPluginPointer } = createMarketplaceIndexService({ registryHost: registry });
    const store = createPluginRegistryStateStore({ happyHomeDir });
    const prepare = createDaemonPathPluginChangePreparer({ happyHomeDir, readGitPluginPointer,
      runtimeLifecycle: { prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }) } });
    const changes = createDaemonPluginChangeService({ prepare: async (request, signal) => {
      if (request.kind !== 'update') return prepare(request, undefined, signal);
      const update = resolveInstalledPluginUpdate(request.pluginId, (await store.read()).plugins[request.pluginId]);
      return prepare(update.request, { installedUpdate: { pluginId: request.pluginId } }, signal);
    } });
    try {
      await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
      await mkdir(join(pluginRoot, 'commands'), { recursive: true });
      await writeFile(join(pluginRoot, 'commands', 'runbook.md'), 'Follow the runbook.\n');
      await run(['init', '-qb', 'catalog-branch']);
      const writeVersion = (version: string) => writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'),
        JSON.stringify({ name: 'vendor-kit', version, hooks: { PostToolUse: [] } }));
      const commit = async (version: string) => {
        await writeVersion(version);
        await run(['add', '.']);
        await run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', version]);
      };
      await commit('1.2.0');
      await run(['tag', 'v1.2.0']);
      const released = await run(['rev-parse', 'HEAD']);
      await commit('2.0.0');
      catalogRef = await run(['rev-parse', 'HEAD']);
      await run(['branch', 'v1.2.0', catalogRef]);
      const expectedCommit = mode === 'catalog' ? catalogRef : released;
      await commit('3.0.0');
      // Rewrite the acquisition boundary to a real local repo. Git checkout, manifest admission and commits stay real.
      vi.stubEnv('GIT_CONFIG_COUNT', '2');
      vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(repo).href}.insteadOf`);
      vi.stubEnv('GIT_CONFIG_VALUE_0', locator);
      vi.stubEnv('GIT_CONFIG_KEY_1', 'protocol.file.allow');
      vi.stubEnv('GIT_CONFIG_VALUE_1', 'always');
      const action = await executePluginDevLoopAction({ actionId: 'plugins.install',
        input: { machineId: 'home', source: mode === 'catalog' ? { kind: 'gitCatalog', sourceId: 'vendor', itemId: 'kit' }
          : { kind: 'git', locator, subdirectory: 'plugins/kit' } } }, {
        requestUserPluginChange: ({ request, signal }) => changes.requestPluginChange(request, { signal }),
      });
      expect(action).toMatchObject({ pendingReview: { kind: 'reviewRequired', reviewKind: 'installation', review: {
        source: { kind: 'git', locator, subdirectory: 'plugins/kit', resolvedCommit: expectedCommit },
        version: mode === 'catalog' ? '2.0.0' : '1.2.0',
        notImported: { hooks: 1, agents: 0, commands: 0, mcpServers: 0 },
      } } });
      if (!action || typeof action !== 'object' || !('pendingReview' in action)) throw new Error('Missing approval');
      const pendingReview = action.pendingReview as { pendingChangeId: string };
      await expect(changes.decidePluginChange({ pendingChangeId: pendingReview.pendingChangeId, decision: 'approve' }))
        .resolves.toMatchObject({ kind: 'committed' });
      const [installed] = await readInstalledPluginCatalog({ happyHomeDir });
      expect(installed?.manifest?.contributes.skills).toMatchObject([{ id: 'command-runbook' }]);
      const entry = InstalledPluginCapabilityEntryV1Schema.parse(installed);
      expect(entry.source)
        .toMatchObject({ kind: 'git', locator, subdirectory: 'plugins/kit', resolvedCommit: expectedCommit, notImported: { hooks: 1 } });
      const materializedRoot = installed?.source.resolvedPath;
      expect(materializedRoot).toBeTruthy();
      await expect(readFile(join(materializedRoot!, '.happier-plugin', 'imported', 'command-runbook', 'SKILL.md'), 'utf8'))
        .resolves.toContain('Follow the runbook.');
      expect(getJson).toHaveBeenCalledTimes(mode === 'catalog' ? 1 : 0);
      expect(releaseFetch).toHaveBeenCalledTimes(mode === 'catalog' ? 0 : 1);
      if (mode === 'catalog') {
        const tracker = createPluginRegistryUpdateTracker({ happyHomeDir, readGitPluginPointer });
        const checker = createRegistryUpdateCheck({ trackers: [tracker], ctx: { http }, readSources });
        const observations = async () => (await checker.checkNow({ kind: 'plugin', keys: [entry.pluginId] })).results[0]?.upstream;
        await checker.runBackgroundAutoUpdateCheck();
        expect(getJson).toHaveBeenCalledTimes(1);
        expect(await observations()).toMatchObject({ state: 'current' });
        await writeFile(join(pluginRoot, 'commands', 'runbook.md'), 'Use the updated runbook.\n');
        await commit('2.0.0');
        const updated = await run(['rev-parse', 'HEAD']);
        catalogRef = 'refs/heads/catalog-branch';
        expect(await observations()).toMatchObject({ state: 'update_available', latest: { kind: 'version', version: '2.0.0' } });
        const result = await changes.requestPluginChange({ kind: 'update', pluginId: entry.pluginId });
        expect(result).toMatchObject({ kind: 'committed' });
        expect(InstalledPluginCapabilityEntryV1Schema.parse((await readInstalledPluginCatalog({ happyHomeDir }))[0]).source)
          .toMatchObject({ resolvedCommit: updated });
        expect(getJson).toHaveBeenCalledTimes(4);
        expect(releaseFetch).not.toHaveBeenCalled();
      }
    } finally {
      vi.unstubAllEnvs();
      await changes.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
