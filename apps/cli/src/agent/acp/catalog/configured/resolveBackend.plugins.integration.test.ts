import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginStateStore } from '@/plugins/store/state';

import { resolveConfiguredAcpBackendFromAccountSettingsOrPlugins } from './resolveBackend';

async function writePluginFixture(rootDir: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(rootDir, 'daemon.mjs'), 'export {};\n', 'utf8');
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: 'acme.integration.plugin',
        version: '1.0.0',
        displayName: 'Acme Integration Plugin',
        description: 'Contributes an ACP backend via local-path plugin state',
        engines: {
          happier: '^0.2.0',
        },
        runtime: {
          apiVersion: 1,
          capabilities: ['providers', 'backends'],
        },
        targets: {
          daemon: {
            entry: './daemon.mjs',
          },
        },
        permissions: [],
        contributions: [
          {
            kind: 'provider',
            kindVersion: 1,
            id: 'acme.integration.provider',
            display: {
              name: 'Acme Integration Provider',
              tags: ['plugin'],
            },
            ownedBackendIds: [
              'acme.integration.backend',
              'acme.integration.agent-cli.backend',
            ],
          },
          {
            kind: 'backend',
            kindVersion: 1,
            id: 'acme.integration.backend',
            providerId: 'acme.integration.provider',
            engine: {
              kind: 'acp',
              transport: {
                kind: 'stdio',
                launch: {
                  kind: 'executable',
                  command: 'plugin-acp-cli',
                  args: ['acp', '--session'],
                  env: {
                    ACP_REGION: 'eu',
                  },
                },
              },
              ux: {
                title: 'Integration ACP Backend',
                description: 'Runs ACP through plugin declarative metadata',
                defaultMode: 'plan',
                defaultModel: 'plugin-pro',
              },
              capabilities: {
                supportsResume: true,
                supportsStreaming: true,
                supportsModes: true,
                supportsModels: true,
                supportsConfigOptions: 'unknown',
                supportsPromptImages: false,
                customMessageKinds: ['acme.delta'],
              },
              auth: {
                config: {
                  support: 'manual_only',
                  docsUrl: 'https://example.com/acp-auth',
                },
              },
            },
            capabilities: {
              externalSessions: true,
            },
            runtimeAdapters: [],
          },
          {
            kind: 'backend',
            kindVersion: 1,
            id: 'acme.integration.agent-cli.backend',
            providerId: 'acme.integration.provider',
            engine: {
              kind: 'acp',
              transport: {
                kind: 'stdio',
                launch: {
                  kind: 'agent-cli',
                  agentId: 'kiro',
                  args: ['--acp'],
                },
              },
              ux: {
                title: 'Agent CLI ACP Backend',
              },
              capabilities: {
                supportsResume: true,
              },
            },
            capabilities: {
              externalSessions: true,
            },
            runtimeAdapters: [],
          },
        ],
      }),
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
      auth: {
        support: 'manual_only',
      },
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

  it('keeps final plugin ACP agent-cli launch definitions discoverable for runtime normalization', async () => {
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
      backendId: 'acme.integration.agent-cli.backend',
      happyHomeDir,
    });

    expect(resolved).toMatchObject({
      backendId: 'acme.integration.agent-cli.backend',
      title: 'Agent CLI ACP Backend',
      launch: {
        kind: 'agent-cli',
        agentId: 'kiro',
        args: ['--acp'],
      },
    });
  });
});
