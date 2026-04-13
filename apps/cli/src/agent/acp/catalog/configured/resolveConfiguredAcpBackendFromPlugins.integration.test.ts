import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/extensions/plugins/store/pluginStateStore';

import { resolveConfiguredAcpBackendFromAccountSettingsOrPlugins } from './resolveConfiguredAcpBackendFromAccountSettings';

async function writePluginFixture(rootDir: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: 'acme.integration.plugin',
        version: '1.0.0',
        displayName: 'Acme Integration Plugin',
        description: 'Contributes an ACP backend via local-path plugin state',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.mjs',
          },
        },
        contributions: {
          providers: [
            {
              kindVersion: 1,
              id: 'acme.integration.provider',
              display: {
                name: 'Acme Integration Provider',
                tags: ['plugin'],
              },
              ownedBackendIds: ['acme.integration.backend'],
            },
          ],
          backends: [
            {
              kindVersion: 1,
              id: 'acme.integration.backend',
              providerId: 'acme.integration.provider',
              runtimeKind: 'acp',
              launch: {
                command: 'ignored-launch-command',
                args: ['--ignored'],
                env: {
                  SHOULD_NOT_APPEAR: '1',
                },
              },
              acp: {
                title: 'Integration ACP Backend',
                description: 'Runs ACP through plugin declarative metadata',
                command: 'plugin-acp-cli',
                args: ['acp', '--session'],
                env: {
                  ACP_REGION: { t: 'literal', v: 'eu' },
                },
                transportProfile: 'generic',
                capabilities: {
                  supportsLoadSession: true,
                  supportsModes: 'yes',
                  supportsModels: 'yes',
                  supportsConfigOptions: 'unknown',
                  promptImageSupport: 'no',
                },
                defaultMode: 'plan',
                defaultModel: 'plugin-pro',
              },
              capabilities: {
                directSessions: true,
              },
            },
          ],
          hooks: [],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('resolveConfiguredAcpBackendFromAccountSettingsOrPlugins (integration)', () => {
  it('resolves a configured ACP backend from enabled local-path plugin contributions when account settings do not define it', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-configured-acp-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-configured-acp-plugin-root-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginFixture(pluginRoot);
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.integration.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const resolved = await resolveConfiguredAcpBackendFromAccountSettingsOrPlugins({
      settings: {},
      backendId: 'acme.integration.backend',
      happyHomeDir,
    });

    expect(resolved).toMatchObject({
      backendId: 'acme.integration.backend',
      name: 'acme.integration.backend',
      title: 'Integration ACP Backend',
      description: 'Runs ACP through plugin declarative metadata',
      command: 'plugin-acp-cli',
      args: ['acp', '--session'],
      transportProfile: 'generic',
      defaultMode: 'plan',
      defaultModel: 'plugin-pro',
    });
    expect(resolved?.env).toEqual({
      ACP_REGION: { t: 'literal', v: 'eu' },
    });
    expect(resolved?.capabilities).toEqual({
      supportsLoadSession: true,
      supportsModes: 'yes',
      supportsModels: 'yes',
      supportsConfigOptions: 'unknown',
      promptImageSupport: 'no',
    });
  });

  it('keeps account settings as the canonical first match when both account settings and plugins define the same backend id', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-configured-acp-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-configured-acp-plugin-root-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginFixture(pluginRoot);
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.integration.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const resolved = await resolveConfiguredAcpBackendFromAccountSettingsOrPlugins({
      settings: {
        acpCatalogSettingsV1: {
          v: 2,
          backends: [
            {
              id: 'acme.integration.backend',
              name: 'acme.integration.backend',
              title: 'Account Settings Backend',
              command: 'settings-acp-cli',
              args: ['acp', '--from-settings'],
              env: {},
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: false,
                supportsModes: 'no',
                supportsModels: 'no',
                supportsConfigOptions: 'no',
                promptImageSupport: 'unknown',
              },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
      backendId: 'acme.integration.backend',
      happyHomeDir,
    });

    expect(resolved).toMatchObject({
      backendId: 'acme.integration.backend',
      title: 'Account Settings Backend',
      command: 'settings-acp-cli',
      args: ['acp', '--from-settings'],
    });
  });
});
