import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginStateStore } from '@/plugins/store/state.testkit';

import {
  listConfiguredAcpBackendsFromAccountSettingsOrPlugins,
  resolveConfiguredAcpBackendFromAccountSettingsOrPlugins,
} from './resolveBackend';

async function writePluginFixture(rootDir: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(rootDir, 'daemon.mjs'), 'export {};\n', 'utf8');
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        id: 'acme.integration.plugin',
        displayName: 'Acme Integration Plugin',
        description: 'Contributes an ACP backend via local-path plugin state',
        uses: ['agents'],
        contributes: {
          agents: [
          {
            id: 'acme.integration.backend',
            runtime: {
              kind: 'acp',
              transport: {
                kind: 'stdio',
                executable: {
                  kind: 'systemTool',
                  id: 'plugin-acp-cli',
                },
                args: ['acp', '--session'],
                env: {
                  ACP_REGION: 'eu',
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
          },
          ],
          systemTools: [{
            toolId: 'plugin-acp-cli',
            displayName: 'Plugin ACP CLI',
            source: 'system',
            lookupNames: ['plugin-acp-cli'],
            defaultArgs: [],
          }],
        },
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
      source: {
        kind: 'plugin_contributed',
        pluginId: 'acme.integration.plugin',
      },
      launch: {
        kind: 'system-tool',
        toolId: 'plugin-acp-cli',
        args: ['acp', '--session'],
      },
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

    await expect(listConfiguredAcpBackendsFromAccountSettingsOrPlugins({
      settings: {},
      happyHomeDir,
    })).resolves.toEqual([
      expect.objectContaining({
        backendId: 'acme.integration.backend',
        source: expect.objectContaining({
          kind: 'plugin_contributed',
          pluginId: 'acme.integration.plugin',
        }),
        launch: expect.objectContaining({
          kind: 'system-tool',
          toolId: 'plugin-acp-cli',
        }),
      }),
    ]);
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
