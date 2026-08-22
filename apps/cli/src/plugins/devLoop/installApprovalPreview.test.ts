import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { buildPluginInstallApprovalPreview } from './installApprovalPreview';

async function materializePlugin(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await writeFile(join(rootDir, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: 'acme.install-preview',
      version: '1.2.3',
      displayName: 'Acme Install Preview',
      hostAccess: {
        required: [
          {
            id: 'network', capability: 'network', reason: 'Call the fixture API.',
            scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['GET'] },
          },
          {
            id: 'workspace', capability: 'filesystem', reason: 'Read the workspace.',
            scope: { locations: [{ root: 'workspace' }], access: ['read', 'delete'] },
          },
          {
            id: 'gateway', capability: 'network.client', reason: 'Maintain the gateway connection.',
            scope: {
              targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
              transports: ['websocket'],
            },
          },
        ],
        optional: [
          {
            id: 'synced-storage', capability: 'storage.account', reason: 'Synchronize state when selected.',
            scope: { enabled: true },
          },
        ],
      },
    }), null, 2),
    'utf8',
  );
}

describe('buildPluginInstallApprovalPreview', () => {
  it('summarizes local plugin identity, source provenance, and declared permissions before install', async () => {
    const workspaceRoot = await createTempDir('happier-plugin-install-preview-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-install-preview-source-', workspaceRoot);
    await materializePlugin(pluginRoot);

    try {
      const preview = await buildPluginInstallApprovalPreview({
        input: {
          path: pluginRoot,
          dev: true,
          force: true,
        },
        defaultPreview: {
          actionId: 'plugins.install',
          actionArgs: {
            path: pluginRoot,
            dev: true,
            force: true,
          },
        },
        workspaceRoot,
      });

      expect(preview).toEqual(expect.objectContaining({
        actionId: 'plugins.install',
        actionArgs: {
          path: pluginRoot,
          dev: true,
          force: true,
        },
        pluginInstall: expect.objectContaining({
          plugin: expect.objectContaining({
            id: 'acme.install-preview',
            version: '1.2.3',
            title: 'Acme Install Preview',
          }),
          source: expect.objectContaining({
            kind: 'path',
            locator: expect.stringContaining('happier-plugin-install-preview-source-'),
            dev: true,
            force: true,
            trustPolicy: 'prompt',
            installPolicy: 'link',
          }),
          provenance: expect.objectContaining({
            sourceKind: 'path',
            manifestPath: expect.stringContaining(join('happier-plugin-install-preview-source-')),
          }),
          permissions: {
            required: [
              {
                id: 'network',
                capability: 'network',
                reason: 'Call the fixture API.',
                authorizationClass: 'cooperativeDisclosure',
                normalizedScope: {
                  targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }],
                  methods: ['GET'],
                },
              },
              {
                id: 'workspace',
                capability: 'filesystem',
                reason: 'Read the workspace.',
                authorizationClass: 'cooperativeDisclosure',
                normalizedScope: {
                  locations: [{ root: 'workspace' }],
                  access: ['delete', 'read'],
                },
              },
              {
                id: 'gateway',
                capability: 'network.client',
                reason: 'Maintain the gateway connection.',
                authorizationClass: 'cooperativeDisclosure',
                normalizedScope: {
                  targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
                  transports: ['websocket'],
                  privateNetwork: false,
                },
              },
            ],
            optional: [{
              id: 'synced-storage',
              capability: 'storage.account',
              reason: 'Synchronize state when selected.',
              authorizationClass: 'hostResourceSelection',
              normalizedScope: { enabled: true },
            }],
          },
        }),
      }));
      expect(preview).not.toHaveProperty('pluginInstall.provenance.manifestDigest');
    } finally {
      await removeTempDir(workspaceRoot);
    }
  });

  it('previews arbitrary local dev installs outside the workspace as prompt-trust installs', async () => {
    const workspaceRoot = await createTempDir('happier-plugin-install-preview-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-install-preview-outside-');
    await materializePlugin(pluginRoot);

    try {
      const preview = await buildPluginInstallApprovalPreview({
        input: {
          path: pluginRoot,
          dev: true,
        },
        defaultPreview: {
          actionId: 'plugins.install',
          actionArgs: {
            path: pluginRoot,
            dev: true,
          },
        },
        workspaceRoot,
      });

      expect(preview).toEqual(expect.objectContaining({
        pluginInstall: expect.objectContaining({
          source: expect.objectContaining({
            kind: 'path',
            dev: true,
            trustPolicy: 'prompt',
            installPolicy: 'link',
          }),
        }),
      }));
    } finally {
      await removeTempDir(pluginRoot);
      await removeTempDir(workspaceRoot);
    }
  });
});
