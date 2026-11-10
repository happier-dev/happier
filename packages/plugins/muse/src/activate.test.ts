import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_AGENTS_CORE } from '@happier-dev/agents';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { resolveBundledPluginEnablement } from '@/plugins/projection/registry/builtIn/enablement';
import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

describe('Muse selected-Agent admission', () => {
  it.each([true, false])('keeps native work at zero for passive Muse enablement=%s', async enabled => {
    const scratch = await fsPromises.mkdtemp(join(tmpdir(), 'happier-muse-passive-'));
    const configRoot = join(scratch, 'config');
    const dataRoot = join(scratch, 'data');
    await fsPromises.mkdir(configRoot);
    await fsPromises.mkdir(dataRoot);
    vi.stubEnv('XDG_CONFIG_HOME', configRoot);
    vi.stubEnv('XDG_DATA_HOME', dataRoot);
    vi.stubEnv('HOME', scratch);
    vi.stubEnv('USERPROFILE', scratch);
    // Observe genuine OS boundaries without replacing execution, registration,
    // enablement or any native-home reader. Static plugin manifests may load.
    const processes = [vi.spyOn(childProcess, 'spawn'), vi.spyOn(childProcess, 'spawnSync'),
      vi.spyOn(childProcess, 'exec'), vi.spyOn(childProcess, 'execSync'),
      vi.spyOn(childProcess, 'execFile'), vi.spyOn(childProcess, 'execFileSync')];
    const reads = [vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'readFile'),
      vi.spyOn(fs, 'readdirSync'), vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'watch'),
      vi.spyOn(fsPromises, 'readFile'), vi.spyOn(fsPromises, 'readdir'),
      vi.spyOn(fsPromises, 'stat'), vi.spyOn(fsPromises, 'open'), vi.spyOn(fsPromises, 'access')];
    // Keep already-imported builtin named bindings on these same OS spies.
    syncBuiltinESMExports();
    function nativeHomePath(path: unknown): boolean {
      const value = path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString('utf8') : path;
      return typeof value === 'string' && [configRoot, dataRoot]
        .some(root => isCanonicalAbsolutePathInsideRoot(root, value));
    }
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
      const pluginIds = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map(plugin => plugin.pluginId);
      const contributes = getResolvedContributionRegistry({ pluginEnablementById: resolveBundledPluginEnablement({
        pluginIds, machineEnabledById: Object.fromEntries(pluginIds.map(id => [id, id === 'happier.agent.muse' && enabled])),
      }) });
      expect(contributes.agents.some(agent => agent.id === 'muse')).toBe(enabled);
      if (!enabled) expect(contributes.unavailableAgentPluginsByBackendId?.muse).toMatchObject({ code: 'plugin_disabled' });
      fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: join(scratch, 'happier'), runtimeOptions: {
        contributes, pluginIds: [],
        scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
      } });
      expect(fixture.registry.activatedPluginIds.has('happier.agent.muse')).toBe(false);
      await fixture.dispose();
      expect(processes.map(spy => spy.mock.calls.length)).toEqual(processes.map(() => 0));
      expect(reads.flatMap(spy => spy.mock.calls.map(call => call[0])).filter(nativeHomePath)).toEqual([]);
    } finally {
      await fixture?.dispose();
      for (const spy of [...reads, ...processes]) spy.mockRestore();
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
      await fsPromises.rm(scratch, { recursive: true, force: true });
    }
  });

  it('admits the authored Muse manifest with its network disclosure through the canonical manifest boundary', async () => {
    const { PLUGIN_MANIFEST } = await import('./manifest.js');
    const ingestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(ingestion.ok, JSON.stringify(ingestion)).toBe(true);
    if (!ingestion.ok) throw new Error('Muse manifest admission failed');
    expect(ingestion.manifest.contributes.agents.find(agent => agent.id === 'muse')).toMatchObject({
      catalog: { vendorResume: { support: 'supported' } },
      capabilities: { sessions: { open: ['create', 'resume', 'fork'] } },
    });
    expect(ingestion.manifest.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'muse-account-network', capability: 'network',
      scope: { targets: [
        { kind: 'fixedOrigin', origin: 'https://auth.meta.com' },
        { kind: 'fixedOrigin', origin: 'https://api.meta.ai' },
      ], methods: ['POST'] },
    }));
  });
  it('offers Muse with a reachable custom Session runtime in the host catalog', () => {
    const muse = Object.values(CANONICAL_AGENTS_CORE).find(agent => agent.id === 'muse');
    expect(muse, 'selected Muse must exist before the host can admit a Session').toBeDefined();
    expect(muse?.id).toBe('muse');
  });
});
