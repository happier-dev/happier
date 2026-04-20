import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore, resolvePluginStorePaths } from './state';

describe('pluginStateStore', () => {
  it('reads an empty default state when the plugin registry file does not exist yet', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });

    await expect(store.read()).resolves.toEqual({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {},
    });
  });

  it('writes the canonical plugin state file under the extensions/plugins state directory', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const paths = resolvePluginStorePaths({ happyHomeDir });

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.ohmypi': {
          source: {
            kind: 'path',
            locator: '/plugins/acme-ohmypi',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedDigest: 'sha256:abc123',
            resolvedPath: '/plugins/acme-ohmypi',
            manifestPath: '/plugins/acme-ohmypi/.happier-plugin/plugin.json',
          },
          compatibility: {
            status: 'compatible',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: 'sha256:abc123',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    await expect(access(paths.stateFilePath)).resolves.toBeUndefined();
    const parsed = JSON.parse(await readFile(paths.stateFilePath, 'utf8'));
    expect(parsed.plugins['acme.ohmypi'].state.enabled).toBe(true);
    await expect(store.read()).resolves.toMatchObject({
      plugins: {
        'acme.ohmypi': {
          source: {
            manifestPath: '/plugins/acme-ohmypi/.happier-plugin/plugin.json',
          },
          state: {
            enabled: true,
          },
        },
      },
    });
  });

  it('rejects future plugin state schema versions fail-closed', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const paths = resolvePluginStorePaths({ happyHomeDir });

    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(
      paths.stateFilePath,
      JSON.stringify({
        t: 'happier_plugin_state_v1',
        schemaVersion: 2,
        plugins: {},
      }),
      'utf8',
    );

    await expect(store.read()).rejects.toThrow(/Invalid plugin state file/);
  });

  it('rejects partial legacy plugin records fail-closed', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const paths = resolvePluginStorePaths({ happyHomeDir });

    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(
      paths.stateFilePath,
      JSON.stringify({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.legacy': {
            state: {
              enabled: true,
            },
          },
        },
      }),
      'utf8',
    );

    await expect(store.read()).rejects.toThrow(/Invalid plugin state file/);
  });

  it('serializes concurrent transactional updates so plugin state changes are not lost', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });

    await Promise.all([
      store.update(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ...state,
          plugins: {
            ...state.plugins,
            'acme.alpha': {
              source: {
                kind: 'path',
                locator: '/plugins/acme-alpha',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
                resolvedDigest: 'sha256:alpha',
                resolvedPath: '/plugins/acme-alpha',
                manifestPath: '/plugins/acme-alpha/.happier-plugin/plugin.json',
              },
              compatibility: {
                status: 'compatible',
                diagnostics: [],
              },
              install: {
                mode: 'link',
                manifestVersion: '1.0.0',
                manifestDigest: 'sha256:alpha',
                installedPath: null,
              },
              state: {
                enabled: true,
              },
            },
          },
        };
      }),
      store.update(async (state) => ({
        ...state,
        plugins: {
          ...state.plugins,
          'acme.beta': {
            source: {
              kind: 'path',
              locator: '/plugins/acme-beta',
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedDigest: 'sha256:beta',
              resolvedPath: '/plugins/acme-beta',
              manifestPath: '/plugins/acme-beta/.happier-plugin/plugin.json',
            },
            compatibility: {
              status: 'compatible',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: 'sha256:beta',
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      })),
    ]);

    await expect(store.read()).resolves.toMatchObject({
      plugins: {
        'acme.alpha': expect.any(Object),
        'acme.beta': expect.any(Object),
      },
    });
  });
});
