import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state.testkit';

import { reloadTrustedLocalPluginTool } from './reloadTrustedLocalPluginTool';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';

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
    const requestChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.dev.plugin',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));

    try {
      await writePluginState({
        happyHomeDir,
        pluginId: 'acme.dev.plugin',
      });

      const result = await reloadTrustedLocalPluginTool({
        happyHomeDir,
        pluginId: 'acme.dev.plugin',
        requestChange,
      });

      expect(requestChange).toHaveBeenCalledWith({
        request: {
          kind: 'development',
          pluginId: 'acme.dev.plugin',
          sourceRootPath: '/plugins/acme.dev.plugin',
        },
        approval: 'none',
      });
      expect(result).toEqual({
        ok: true,
        result: {
          pluginId: 'acme.dev.plugin',
          activeGenerationId: 'generation-1',
          changedPluginIds: ['acme.dev.plugin'],
          registryStatus: 'active',
          diagnostics: [],
        },
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('lets daemon policy reject an unapproved local dev source instead of trusting the source-policy string', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-tool-reload-home-'));
    const requestChange = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: createPluginInstallationReviewFixture({
        pluginId: 'acme.remote.plugin',
        displayName: 'Remote',
        source: { kind: 'path' as const, locator: '/plugins/acme.remote.plugin' },
        updateChannel: { kind: 'path', locator: '/plugins/acme.remote.plugin', development: true },
        executableRealms: ['daemon' as const],
      }),
    }));

    try {
      await writePluginState({
        happyHomeDir,
        pluginId: 'acme.remote.plugin',
        trustPolicy: 'prompt',
      });

      const result = await reloadTrustedLocalPluginTool({
        happyHomeDir,
        pluginId: 'acme.remote.plugin',
        requestChange,
      });

      expect(result).toEqual({
        ok: false,
        errorCode: 'plugin_reload_not_allowed',
        error: 'Only enabled trusted local dev plugins can be reloaded from the tool bridge',
      });
      expect(requestChange).toHaveBeenCalledTimes(1);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
