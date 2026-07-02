import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { createPluginStateStore } from '@/plugins/store/state';

import { resolveConfiguredAcpProbeCacheVariant } from './configuredAcpProbeCacheVariant';

function buildAccountSettingsWithConfiguredBackend(params: Readonly<{
  backendId: string;
  env: Readonly<Record<string, unknown>>;
}>): Readonly<Record<string, unknown>> {
  return {
    acpCatalogSettingsV1: {
      backends: [
        {
          id: params.backendId,
          name: params.backendId,
          title: 'Configured ACP',
          command: '/bin/acp',
          args: [],
          env: params.env,
          auth: { support: 'manual_only' },
          transportProfile: 'generic',
          capabilities: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  };
}

async function writePluginFixture(rootDir: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        id: 'acme.probe.variant.plugin',
        version: '1.0.0',
        displayName: 'Probe Variant Plugin',
        description: 'Contributes an ACP backend used for probe cache variants',
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
            id: 'acme.probe.variant.provider',
            providerAgentId: 'customAcp',
            display: {
              name: 'Probe Variant Provider',
              tags: ['plugin'],
            },
            ownedBackendIds: ['acme.probe.variant.backend'],
          },
          {
            kind: 'backend',
            kindVersion: 1,
            id: 'acme.probe.variant.backend',
            providerId: 'acme.probe.variant.provider',
            runtimeKind: 'acp',
            capabilities: {
              supportsModels: true,
              supportsModes: true,
              supportsConfigOptions: true,
            },
            surfaceHandlers: [],
            launch: {
              command: 'plugin-variant-launch',
              args: ['--ignored'],
              env: {},
            },
            acp: {
              title: 'Plugin Variant Backend',
              command: 'plugin-variant-cli',
              args: ['acp'],
              env: {
                REGION: { t: 'literal', v: 'eu' },
              },
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: false,
                supportsModes: 'yes',
                supportsModels: 'yes',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(join(rootDir, 'daemon.mjs'), 'export default async function activate() { return null; }\n', 'utf8');
}

describe('resolveConfiguredAcpProbeCacheVariant', () => {
  it('does not leak secret env/auth values into the cache variant (uses a digest)', async () => {
    const backendTarget: BackendTargetRefV1 = { kind: 'configuredAcpBackend', backendId: 'b1' };
    const accountSettings = buildAccountSettingsWithConfiguredBackend({
      backendId: 'b1',
      env: {
        TOKEN: { t: 'literal', v: 'secret-value' },
      },
    });

    const variant = await resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings,
    });

    expect(variant).toMatch(/^configuredAcp:b1:[A-Za-z0-9_-]+$/);
    expect(variant).not.toContain('secret-value');
    expect(variant).not.toContain('TOKEN');
  });

  it('is stable across key ordering (env keys are sorted before hashing)', async () => {
    const backendTarget: BackendTargetRefV1 = { kind: 'configuredAcpBackend', backendId: 'b2' };
    const left = buildAccountSettingsWithConfiguredBackend({
      backendId: 'b2',
      env: {
        B: { t: 'literal', v: 'b' },
        A: { t: 'literal', v: 'a' },
      },
    });
    const right = buildAccountSettingsWithConfiguredBackend({
      backendId: 'b2',
      env: {
        A: { t: 'literal', v: 'a' },
        B: { t: 'literal', v: 'b' },
      },
    });

    await expect(resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings: left,
    })).resolves.toEqual(await resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings: right,
    }));
  });

  it('derives a digest variant for plugin-contributed configured ACP backends', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-configured-acp-variant-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-configured-acp-variant-plugin-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginFixture(pluginRoot);
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.probe.variant.plugin': {
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
    const variant = await resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'acme.probe.variant.backend' },
      accountSettings: {},
      happyHomeDir,
    });

    expect(variant).toMatch(/^configuredAcp:acme\.probe\.variant\.backend:[A-Za-z0-9_-]+$/);
    expect(variant).not.toContain('missing-backend');
  });
});
