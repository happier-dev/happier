import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { inspectPluginSource } from './source';

async function materializeInstallCandidate(
  pluginId: string,
  parentDir = tmpdir(),
  prefix = 'happier-plugin-install-source-',
): Promise<string> {
  const pluginRoot = await mkdtemp(join(parentDir, prefix));
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, 'daemon.mjs'), 'export async function activate() {}\n', 'utf8');
  await writeFile(
    join(pluginRoot, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: 'Install transaction fixture',
      description: 'Staged review must precede immutable publication',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    })),
    'utf8',
  );
  return pluginRoot;
}

describe('inspectPluginSource', () => {
  it('inspects local bytes without publishing or trusting them', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-install-home-'));
    const pluginId = 'acme.review-required';
    const pluginRoot = await materializeInstallCandidate(pluginId);

    const inspected = await inspectPluginSource({
      happyHomeDir,
      locator: pluginRoot,
    });

    expect(inspected).toMatchObject({
      ok: true,
      pluginId,
      installedPath: null,
      source: { trustPolicy: 'prompt' },
    });
    expect(inspected).not.toHaveProperty('manifestDigest');
    if (inspected.ok) {
      expect(inspected.source).not.toHaveProperty('resolvedDigest');
    }

    const state = await createPluginRegistryStateStore({ happyHomeDir }).read();
    expect(state.plugins[pluginId]).toBeUndefined();
  });

  it('has no publication mode, so the daemon change owner remains the only mutator', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-install-owner-home-'));
    const pluginId = 'acme.daemon-owner';
    const pluginRoot = await materializeInstallCandidate(pluginId);

    const result = await inspectPluginSource({
      happyHomeDir,
      locator: pluginRoot,
    });

    expect(result).toMatchObject({
      ok: true,
      pluginId,
      installedPath: null,
    });
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins[pluginId]).toBeUndefined();
  });

  it('keeps a dev plugin under a workspace when its path begins with two dots', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-install-dot-home-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-install-dot-workspace-'));
    const pluginRoot = await materializeInstallCandidate(
      'acme.dot-prefixed-source',
      workspaceRoot,
      '..build-',
    );

    try {
      const inspected = await inspectPluginSource({
        happyHomeDir,
        locator: pluginRoot,
        dev: true,
        workspaceRoot,
      });

      expect(inspected).toMatchObject({
        ok: true,
        source: {
          trustPolicy: 'prompt',
          installPolicy: 'link',
          devWatch: true,
        },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
