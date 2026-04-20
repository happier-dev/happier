import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPluginManifest } from './read';

async function writeManifestFile(rootDir: string, contents: string): Promise<string> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, 'plugin.json');
  await writeFile(manifestPath, contents, 'utf8');
  return manifestPath;
}

function createBaseManifestV2(
  overrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 2,
    id: 'acme.test',
    version: '1.0.0',
    displayName: 'Acme Test Manifest',
    description: 'Test manifest',
    engines: {
      happier: '^0.2.0',
    },
    runtime: {
      apiVersion: 1,
      capabilities: [],
    },
    targets: {},
    permissions: [],
    contributions: [],
    ...overrides,
  };
}

describe('readPluginManifest', () => {
  it('reads schemaVersion 2 manifests into the canonical grouped CLI manifest shape', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 2,
        id: 'acme.v2-manifest',
        version: '1.0.0',
        displayName: 'Acme V2 Manifest',
        description: 'Canonical extension manifest',
        engines: {
          happier: '^0.2.0',
        },
        runtime: {
          apiVersion: 1,
          capabilities: ['actions', 'tools', 'commands', 'hooks', 'resources', 'uiDescriptors'],
        },
        targets: {
          daemon: {
            entry: './daemon.mjs',
          },
        },
        permissions: [
          {
            capability: 'actions.execute',
            reason: 'Runs extension actions from the host',
          },
        ],
        contributions: [
          {
            kind: 'provider',
            kindVersion: 1,
            id: 'acme.provider',
            display: {
              name: 'Acme Provider',
            },
            ownedBackendIds: ['acme.backend'],
          },
          {
            kind: 'backend',
            kindVersion: 1,
            id: 'acme.backend',
            providerId: 'acme.provider',
            runtimeKind: 'acp',
            capabilities: {},
            runtimeAdapters: [
              {
                runtimeAdapterApiVersion: 1,
                id: 'backend.terminalRuntime.launch',
                kind: 'terminalRuntime',
                operation: 'launch',
                handler: {
                  target: 'daemon',
                  exportName: 'launchTerminalRuntime',
                },
              },
            ],
          },
          {
            kind: 'action',
            id: 'acme.action',
            title: 'Run Acme',
            description: 'Runs the Acme action',
            scopes: ['settings'],
            surfaces: ['settings'],
            placement: 'primary',
            dangerLevel: 'safe',
            handler: {
              target: 'daemon',
              exportName: 'runAcme',
            },
          },
          {
            kind: 'tool',
            id: 'acme.tool',
            name: 'acme_tool',
            title: 'Acme Tool',
            description: 'Agent-facing Acme tool',
            safety: 'safe',
            surfaces: {
              cli: false,
              mcp: true,
              session_agent: true,
            },
            handler: {
              target: 'daemon',
              exportName: 'runAcmeTool',
            },
          },
          {
            kind: 'command',
            id: 'acme.command',
            command: 'acme review',
            rootHelpLabel: 'happier acme review',
            rootHelpDescription: 'CLI-facing Acme command',
            handler: {
              target: 'daemon',
              exportName: 'runAcmeCommand',
            },
          },
          {
            kind: 'resource',
            id: 'acme.prompt',
            resourceKind: 'prompt',
            path: './prompts/acme.md',
          },
          {
            kind: 'uiDescriptor',
            id: 'acme.status',
            surface: 'status',
            title: 'Acme Status',
            fields: [
              {
                id: 'enabled',
                type: 'boolean',
                title: 'Enabled',
              },
            ],
          },
          {
            kind: 'hook',
            hookApiVersion: 1,
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
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.schemaVersion).toBe(2);
    expect(result.manifest.runtime).toEqual({
      apiVersion: 1,
      capabilities: ['actions', 'tools', 'commands', 'hooks', 'resources', 'uiDescriptors'],
    });
    expect(result.manifest.permissions).toEqual([
      {
        capability: 'actions.execute',
        reason: 'Runs extension actions from the host',
      },
    ]);
    expect(result.manifest.contributions.providers.map((definition) => definition.id)).toEqual(['acme.provider']);
    expect(result.manifest.contributions.backends.map((definition) => definition.id)).toEqual(['acme.backend']);
    expect(result.manifest.contributions.actions.map((definition) => definition.id)).toEqual(['acme.action']);
    expect(result.manifest.contributions.tools.map((definition) => definition.id)).toEqual(['acme.tool']);
    expect(result.manifest.contributions.commands.map((definition) => definition.id)).toEqual(['acme.command']);
    expect(result.manifest.contributions.resources.map((definition) => definition.id)).toEqual(['acme.prompt']);
    expect(result.manifest.contributions.uiDescriptors.map((definition) => definition.id)).toEqual(['acme.status']);
    expect(result.manifest.contributions.hooks.map((definition) => definition.id)).toEqual([
      'backend.terminalRuntime.bindTranscript',
    ]);
  });

  it('rejects schemaVersion 1 manifests (V2-only)', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.v1-manifest',
        version: '1.0.0',
        displayName: 'Acme V1 Manifest',
        description: 'Legacy manifest authoring shape',
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
                name: 'Acme Provider',
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
        code: 'plugin_manifest_invalid',
      }),
    ]);
  });

  it('normalizes hook registrations through the compatibility reader before manifest validation', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.hook-compat',
          displayName: 'Hook Compat',
          description: 'Hook registration compatibility normalization',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'hook',
              id: 'backend.terminalRuntime.bindTranscript',
              category: 'integration',
              scope: 'backend',
              // Intentionally omit executionKind; the compat reader should infer
              // it from the category before schema validation.
              handler: {
                target: 'plugin',
                exportName: 'bindTranscript',
              },
            },
          ],
        }),
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
        ...createBaseManifestV2({
          id: 'acme.no-daemon',
          displayName: 'No Daemon',
          description: 'Missing daemon target',
          targets: {},
          contributions: [
            {
              kind: 'backend',
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
                  operation: 'listCandidates',
                  handler: {
                    target: 'daemon',
                    exportName: 'listCandidates',
                  },
                },
              ],
            },
          ],
        }),
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
        ...createBaseManifestV2({
          id: 'acme.duplicate',
          displayName: 'Duplicate',
          description: 'Duplicate contribution ids',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'provider',
              kindVersion: 1,
              id: 'acme.provider',
              display: {
                name: 'Provider',
              },
              ownedBackendIds: [],
            },
            {
              kind: 'provider',
              kindVersion: 1,
              id: 'acme.provider',
              display: {
                name: 'Provider Duplicate',
              },
              ownedBackendIds: [],
            },
          ],
        }),
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
        ...createBaseManifestV2({
          id: 'acme.incompatible-engine',
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
        }),
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
        ...createBaseManifestV2({
          id: 'acme.unsupported-targets',
          displayName: 'Unsupported Targets',
          description: 'Advertises manifest descriptor targets that the CLI runtime does not implement',
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
        }),
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
        ...createBaseManifestV2({
          id: 'acme.plugin-runtime-target',
          displayName: 'Plugin Runtime Target',
          description: 'Uses an unsupported runtime adapter handler target',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'backend',
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
                  operation: 'launch',
                  handler: {
                    target: 'plugin',
                    exportName: 'launch',
                  },
                },
              ],
            },
          ],
        }),
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
        ...createBaseManifestV2({
          id: 'acme.duplicate-runtime-adapter',
          displayName: 'Duplicate Runtime Adapter',
          description: 'Declares duplicate runtime adapter ids',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'backend',
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
                  operation: 'launch',
                  handler: {
                    target: 'daemon',
                    exportName: 'launch',
                  },
                },
                {
                  runtimeAdapterApiVersion: 1,
                  id: 'backend.terminalRuntime.launch',
                  kind: 'terminalRuntime',
                  operation: 'launch',
                  handler: {
                    target: 'daemon',
                    exportName: 'launchAgain',
                  },
                },
              ],
            },
          ],
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/Duplicate runtime adapter id/i),
      }),
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/Duplicate runtime adapter operation/i),
      }),
    ]));
  });

  it('accepts canonical runtime adapter operations even when adapter ids are opaque host-local identifiers', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.runtime-adapter-operations',
          displayName: 'Runtime Adapter Operations',
          description: 'Uses canonical runtime adapter operations with opaque ids',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'provider',
              kindVersion: 1,
              id: 'acme.runtime-adapter-operations',
              display: {
                name: 'Runtime Adapter Operations',
              },
              ownedBackendIds: ['acme.runtime-adapter-operations.backend'],
            },
            {
              kind: 'backend',
              kindVersion: 1,
              id: 'acme.runtime-adapter-operations.backend',
              providerId: 'acme.runtime-adapter-operations',
              runtimeKind: 'native',
              capabilities: {},
              runtimeAdapters: [
                {
                  runtimeAdapterApiVersion: 1,
                  id: 'launch-adapter',
                  kind: 'terminalRuntime',
                  operation: 'launch',
                  handler: {
                    target: 'daemon',
                    exportName: 'launch',
                  },
                },
              ],
            },
          ],
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
    }));
  });

  it('returns a semantic diagnostic when a runtime adapter operation id is unsupported by the current runtime', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.unsupported-runtime-adapter-op',
          displayName: 'Unsupported Runtime Adapter Operation',
          description: 'Declares a runtime adapter operation id that the host does not support',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'backend',
              kindVersion: 1,
              id: 'acme.unsupported-runtime-adapter-op.backend',
              providerId: 'acme.unsupported-runtime-adapter-op',
              runtimeKind: 'acp',
              capabilities: {},
              runtimeAdapters: [
                {
                  runtimeAdapterApiVersion: 1,
                  id: 'backend.terminalRuntime.futureOperation',
                  kind: 'terminalRuntime',
                  operation: 'futureOperation',
                  handler: {
                    target: 'daemon',
                    exportName: 'futureOperation',
                  },
                },
              ],
            },
          ],
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/unsupported runtime adapter operation/i),
      }),
    ]);
  });

  it('returns a semantic diagnostic when runtime adapter kind and operation id do not align', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.mismatched-runtime-adapter-op',
          displayName: 'Mismatched Runtime Adapter Operation',
          description: 'Declares a runtime adapter operation id under the wrong runtime adapter kind',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'backend',
              kindVersion: 1,
              id: 'acme.mismatched-runtime-adapter-op.backend',
              providerId: 'acme.mismatched-runtime-adapter-op',
              runtimeKind: 'acp',
              capabilities: {},
              runtimeAdapters: [
                {
                  runtimeAdapterApiVersion: 1,
                  id: 'backend.attach.run',
                  kind: 'directSessions',
                  operation: 'run',
                  handler: {
                    target: 'daemon',
                    exportName: 'runAttach',
                  },
                },
              ],
            },
          ],
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/unsupported runtime adapter operation/i),
      }),
    ]);
  });

  it('returns a semantic diagnostic when daemon target entry uses an unsupported extension', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.unsupported-daemon-entry-extension',
          displayName: 'Unsupported Daemon Entry Extension',
          description: 'Declares a daemon target with an unsupported runtime extension',
          targets: {
            daemon: {
              entry: './daemon.ts',
            },
          },
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/unsupported extension/i),
      }),
    ]);
  });

  it('rejects hook registrations whose handler target is not supported by the CLI runtime', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.daemon-hook-target',
          displayName: 'Daemon Hook Target',
          description: 'Uses an unsupported hook handler target',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'hook',
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
        }),
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
        ...createBaseManifestV2({
          id: 'acme.future-hook-version',
          displayName: 'Future Hook Version',
          description: 'Unsupported hook schema version',
          targets: {
            daemon: {
              entry: './daemon.js',
            },
          },
          contributions: [
            {
              kind: 'hook',
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
        }),
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
