import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPluginManifest } from './readPluginManifest';

async function writeManifestFile(rootDir: string, contents: string): Promise<string> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, 'plugin.json');
  await writeFile(manifestPath, contents, 'utf8');
  return manifestPath;
}

describe('readPluginManifest', () => {
  it('normalizes hook registrations through the compatibility reader before manifest validation', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.hook-compat',
        version: '1.0.0',
        displayName: 'Hook Compat',
        description: 'Hook registration compatibility normalization',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        contributions: {
          providers: [],
          backends: [],
          hooks: [
            {
              hookApiVersion: 1,
              id: 'backend.terminalRuntime.bindTranscript',
              category: 'integration',
              scope: 'backend',
              handler: {
                target: 'plugin',
                exportName: 'bindTranscript',
              },
            },
          ],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributions.hooks).toHaveLength(1);
    expect(result.manifest.contributions.hooks[0]).toEqual(
      expect.objectContaining({
        id: 'backend.terminalRuntime.bindTranscript',
        category: 'integration',
        executionKind: 'integrate',
      }),
    );
  });

  it('returns a compatibility diagnostic when the manifest is not valid JSON', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(pluginRoot, '{ invalid json');

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_invalid',
      }),
    ]);
  });

  it('returns a semantic diagnostic when executable contributions omit the daemon target', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.no-daemon',
        version: '1.0.0',
        displayName: 'No Daemon',
        description: 'Missing daemon target',
        engines: {
          happier: '^0.2.0',
        },
        targets: {},
        contributions: {
          providers: [],
          backends: [
            {
              kindVersion: 1,
              id: 'acme.no-daemon.backend',
              providerId: 'acme.no-daemon',
              runtimeKind: 'acp',
              capabilities: {},
              runtimeAdapters: [
                {
                  runtimeAdapterApiVersion: 1,
                  id: 'backend.directSessions.listCandidates',
                  kind: 'directSessions',
                  handler: {
                    target: 'daemon',
                    exportName: 'listCandidates',
                  },
                },
              ],
            },
          ],
          hooks: [],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/Daemon target is required/),
      }),
    ]);
  });

  it('returns a semantic diagnostic when contribution ids are duplicated', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.duplicate',
        version: '1.0.0',
        displayName: 'Duplicate',
        description: 'Duplicate contribution ids',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        contributions: {
          providers: [
            {
              kindVersion: 1,
              id: 'acme.provider',
              display: {
                name: 'Provider',
              },
              ownedBackendIds: [],
            },
            {
              kindVersion: 1,
              id: 'acme.provider',
              display: {
                name: 'Provider Duplicate',
              },
              ownedBackendIds: [],
            },
          ],
          backends: [],
          hooks: [],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/Duplicate provider id/),
      }),
    ]);
  });

  it('returns a semantic diagnostic when the manifest requires an incompatible happier engine range', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.incompatible-engine',
        version: '1.0.0',
        displayName: 'Incompatible Engine',
        description: 'Requires a newer CLI runtime than the current host provides',
        engines: {
          happier: '^99.0.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        contributions: {
          providers: [],
          backends: [],
          hooks: [],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/current CLI version/i),
      }),
    ]);
  });

  it('returns a semantic diagnostic when the manifest advertises unsupported descriptor targets', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.unsupported-targets',
        version: '1.0.0',
        displayName: 'Unsupported Targets',
        description: 'Advertises manifest descriptor targets that the CLI runtime does not implement',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
          uiDescriptor: {
            entry: './ui.js',
          },
          serverDescriptor: {
            entry: './server.js',
          },
        },
        contributions: {
          providers: [],
          backends: [],
          hooks: [],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'plugin_manifest_semantic_invalid',
          message: expect.stringMatching(/uiDescriptor/i),
        }),
        expect.objectContaining({
          code: 'plugin_manifest_semantic_invalid',
          message: expect.stringMatching(/serverDescriptor/i),
        }),
      ]),
    );
  });

  it('returns a semantic diagnostic when a backend runtime adapter targets the plugin runtime', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.plugin-runtime-target',
        version: '1.0.0',
        displayName: 'Plugin Runtime Target',
        description: 'Uses an unsupported runtime adapter handler target',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        contributions: {
          providers: [],
          backends: [
            {
              kindVersion: 1,
              id: 'acme.plugin-runtime-target.backend',
              providerId: 'acme.plugin-runtime-target',
              runtimeKind: 'acp',
              capabilities: {},
              runtimeAdapters: [
                {
                  runtimeAdapterApiVersion: 1,
                  id: 'backend.terminalRuntime.launch',
                  kind: 'terminalRuntime',
                  handler: {
                    target: 'plugin',
                    exportName: 'launch',
                  },
                },
              ],
            },
          ],
          hooks: [],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/unsupported handler target/i),
      }),
    ]);
  });

  it('returns a semantic diagnostic when backend runtime adapter ids are duplicated', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.duplicate-runtime-adapter',
        version: '1.0.0',
        displayName: 'Duplicate Runtime Adapter',
        description: 'Declares duplicate runtime adapter ids',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        contributions: {
          providers: [],
          backends: [
            {
              kindVersion: 1,
              id: 'acme.duplicate-runtime-adapter.backend',
              providerId: 'acme.duplicate-runtime-adapter',
              runtimeKind: 'acp',
              capabilities: {},
              runtimeAdapters: [
                {
                  runtimeAdapterApiVersion: 1,
                  id: 'backend.terminalRuntime.launch',
                  kind: 'terminalRuntime',
                  handler: {
                    target: 'daemon',
                    exportName: 'launch',
                  },
                },
                {
                  runtimeAdapterApiVersion: 1,
                  id: 'backend.terminalRuntime.launch',
                  kind: 'terminalRuntime',
                  handler: {
                    target: 'daemon',
                    exportName: 'launchAgain',
                  },
                },
              ],
            },
          ],
          hooks: [],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/Duplicate runtime adapter id/i),
      }),
    ]);
  });

  it('rejects hook registrations whose handler target is not supported by the CLI runtime', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.daemon-hook-target',
        version: '1.0.0',
        displayName: 'Daemon Hook Target',
        description: 'Uses an unsupported hook handler target',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        contributions: {
          providers: [],
          backends: [],
          hooks: [
            {
              hookApiVersion: 1,
              id: 'backend.terminalRuntime.bindTranscript',
              category: 'integration',
              scope: 'backend',
              executionKind: 'integrate',
              handler: {
                target: 'daemon',
                exportName: 'bindTranscript',
              },
            },
          ],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/unsupported hook handler target/i),
      }),
    ]);
  });

  it('fails closed when a hook registration advertises an unsupported future version', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.future-hook-version',
        version: '1.0.0',
        displayName: 'Future Hook Version',
        description: 'Unsupported hook schema version',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
        },
        contributions: {
          providers: [],
          backends: [],
          hooks: [
            {
              hookApiVersion: 2,
              id: 'backend.terminalRuntime.bindTranscript',
              category: 'integration',
              scope: 'backend',
              executionKind: 'integrate',
              handler: {
                target: 'plugin',
                exportName: 'bindTranscript',
              },
            },
          ],
        },
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_invalid',
      }),
    ]);
  });
});
