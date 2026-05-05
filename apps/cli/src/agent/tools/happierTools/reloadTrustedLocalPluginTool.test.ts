import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state';

import { reloadTrustedLocalPluginTool } from './reloadTrustedLocalPluginTool';

async function writePluginState(params: Readonly<{
  happyHomeDir: string;
  pluginId: string;
  trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
  sourceKind?: 'path' | 'archive';
  installMode?: 'link' | 'managed_install';
  enabled?: boolean;
}>): Promise<void> {
  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  await store.write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [params.pluginId]: {
        source: {
          kind: params.sourceKind ?? 'path',
          locator: `/plugins/${params.pluginId}`,
          trustPolicy: params.trustPolicy ?? 'local_trusted',
          installPolicy: params.installMode === 'managed_install' ? 'managed_install' : 'link',
          resolvedPath: `/plugins/${params.pluginId}`,
          manifestPath: `/plugins/${params.pluginId}/.happier-plugin/plugin.json`,
        },
        compatibility: {
          status: 'unknown',
          diagnostics: [],
        },
        install: {
          mode: params.installMode ?? 'link',
          manifestVersion: '1.0.0',
          manifestDigest: null,
          installedPath: null,
        },
        state: {
          enabled: params.enabled ?? true,
        },
      },
    },
  });
}

describe('reloadTrustedLocalPluginTool', () => {
  it('reloads enabled local trusted link plugins', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-tool-reload-home-'));
    const reload = vi.fn(async () => ({
      ok: true as const,
      generation: 1,
      attemptedGeneration: 1,
      changedPluginIds: ['acme.dev.plugin'],
      affectedPluginIds: ['acme.dev.plugin'],
      activeGenerationId: 'reload:1',
      registryStatus: 'active' as const,
      diagnostics: [],
      diagnosticsByPluginId: {},
      registry: {} as never,
    }));

    try {
      await writePluginState({
        happyHomeDir,
        pluginId: 'acme.dev.plugin',
      });

      const result = await reloadTrustedLocalPluginTool({
        happyHomeDir,
        pluginId: 'acme.dev.plugin',
        reload,
      });

      expect(reload).toHaveBeenCalledWith({ pluginId: 'acme.dev.plugin' });
      expect(result).toEqual({
        ok: true,
        result: {
          pluginId: 'acme.dev.plugin',
          activeGenerationId: 'reload:1',
          changedPluginIds: ['acme.dev.plugin'],
          registryStatus: 'active',
          diagnostics: [],
        },
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('fails closed for plugins that are not trusted local dev links', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-tool-reload-home-'));
    const reload = vi.fn();

    try {
      await writePluginState({
        happyHomeDir,
        pluginId: 'acme.remote.plugin',
        trustPolicy: 'prompt',
        installMode: 'managed_install',
      });

      const result = await reloadTrustedLocalPluginTool({
        happyHomeDir,
        pluginId: 'acme.remote.plugin',
        reload,
      });

      expect(result).toEqual({
        ok: false,
        errorCode: 'plugin_reload_not_allowed',
        error: 'Only enabled trusted local dev plugins can be reloaded from the tool bridge',
      });
      expect(reload).not.toHaveBeenCalled();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
