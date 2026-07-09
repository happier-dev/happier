import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readPluginManifest } from './read';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function writeManifestFile(rootDir: string, contents: string): Promise<string> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, 'plugin.json');
  await writeFile(manifestPath, contents, 'utf8');
  return manifestPath;
}

function retiredLiteral(parts: readonly string[], separator = ''): string {
  return parts.join(separator);
}

function createBaseManifestV2(
  overrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return createPluginManifestV2Fixture({
    schemaVersion: 2,
    id: 'acme.test',
    version: '1.0.0',
    displayName: 'Acme Test Manifest',
    description: 'Test manifest',
    engines: {
      happier: '^0.2.0',
    },
    uses: [],
    entrypoints: {
      main: './daemon.js',
    },
    permissions: {
      required: [],
      optional: [],
    },
    contributes: {},
    ...overrides,
  });
}

function expectedBackendCapabilities(executionRunSupported: boolean): Record<string, unknown> {
  return {
    executionRun: { supported: executionRunSupported },
    session: {
      contextCompaction: {
        events: { supported: false },
        manualTrigger: { supported: false },
        transcriptInference: { supported: false },
      },
      media: {
        acceptsImageInput: { supported: false },
        emitsSessionMedia: { supported: false },
        nativeImageGeneration: { supported: false },
      },
    },
  };
}

function createAgentContribution(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    id: 'acme.backend',
    display: {
      name: 'Acme Agent',
    },
    runtime: {
      kind: 'custom',
    },
    capabilities: {},
    ...overrides,
  };
}

describe('readPluginManifest', () => {
  it('keeps every plugin authoring example on the current v2 manifest contract', async () => {
    const examplesRoot = fileURLToPath(new URL('../testkit/fixtures/authoring-examples/', import.meta.url));
    const entries = await readdir(examplesRoot, { withFileTypes: true });
    const manifestPaths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(examplesRoot, entry.name, '.happier-plugin', 'plugin.json'));

    expect(manifestPaths.length).toBeGreaterThan(0);

    for (const manifestPath of manifestPaths) {
      const raw = await readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.runtime, manifestPath).toBeUndefined();
      expect(parsed.targets, manifestPath).toBeUndefined();
      expect(parsed.capabilities, manifestPath).toBeUndefined();
      expect((parsed.contributes as Record<string, unknown> | undefined)?.backends, manifestPath).toBeUndefined();
      expect(raw, manifestPath).not.toContain(retiredLiteral(['agent', 'Tool']));
      expect(raw, manifestPath).not.toContain(retiredLiteral(['provider', '.', 'response', '.', 'after']));

      const result = await readPluginManifest({ manifestPath });
      expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    }

    const retiredAuthoringVocabulary = [
      retiredLiteral(['targets', '.', 'daemon']),
      retiredLiteral(['runtime', '.', 'capabilities']),
      retiredLiteral(['runtime', '.', 'apiVersion']),
      retiredLiteral(['capabilities', '.', 'permissions']),
      retiredLiteral(['capabilities', '.', 'optionalPermissions']),
      retiredLiteral(['agent', 'Tool']),
      retiredLiteral(['contributes', '.', 'backends']),
      retiredLiteral(['provider', '.', 'response', '.', 'after']),
      retiredLiteral(['provider', '/', 'backend']),
      retiredLiteral(['provider', ' response']),
      retiredLiteral(['daemon', ' target']),
      retiredLiteral(['backend', 'Id']),
      retiredLiteral(['runtime', 'Capabilities']),
      retiredLiteral(['runtimeDescriptor', '.', 'backend', 'Id']),
      retiredLiteral(['examples', '.', 'provider']),
    ];
    for (const filePath of await listFilesRecursive(examplesRoot)) {
      const raw = await readFile(filePath, 'utf8');
      for (const retired of retiredAuthoringVocabulary) {
        expect(raw, `${filePath} contains retired authoring vocabulary: ${retired}`).not.toContain(retired);
      }
    }
  });

  it('reads schemaVersion 2 manifests into the canonical grouped CLI manifest shape', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify(createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: 'acme.v2-manifest',
        version: '1.0.0',
        displayName: 'Acme V2 Manifest',
        description: 'Canonical plugin manifest',
        engines: {
          happier: '^0.2.0',
        },
        uses: ['agents', 'actions', 'tools', 'commands', 'hooks', 'resources', 'uiDescriptors'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [
          {
            capability: 'network',
            reason: 'Calls the Acme service API',
          },
          ],
          optional: [],
        },
        contributes: {
          agents: [{
            id: 'acme.backend',
            runtime: {
              kind: 'acp',
              transport: {
                kind: 'stdio',
                launch: {
                  kind: 'executable',
                  command: 'acme-agent',
                },
              },
              ux: {
                title: 'Acme Backend',
              },
            },
            capabilities: {},
            surfaceHandlers: [
              {
                surfaceApiVersion: 1,
                id: 'backend.terminalRuntime.launch',
                kind: 'terminalRuntime',
                operation: 'launch',
                handler: {
                  target: 'daemon',
                  exportName: 'launchTerminalRuntime',
                },
              },
            ],
          }],
          actions: [{
            id: 'acme.action',
            title: 'Run Acme',
            description: 'Runs the Acme action',
            scopes: ['settings'],
            surfaces: ['cli'],
            placement: 'primary',
            dangerLevel: 'safe',
            handler: {
              target: 'daemon',
              exportName: 'runAcme',
            },
          }],
          tools: [{
            id: 'acme.tool',
            name: 'acme_tool',
            title: 'Acme Tool',
            description: 'Agent-facing Acme tool',
            safety: 'safe',
            surfaces: ['mcp', 'agent'],
            handler: {
              target: 'daemon',
              exportName: 'runAcmeTool',
            },
          }],
          commands: [{
            id: 'acme.command',
            command: 'acme review',
            rootHelpLabel: 'happier acme review',
            rootHelpDescription: 'CLI-facing Acme command',
            handler: {
              target: 'daemon',
              exportName: 'runAcmeCommand',
            },
          }],
          resources: [{
            id: 'acme.prompt',
            resourceKind: 'prompt',
            path: './prompts/acme.md',
          }],
          uiDescriptors: [{
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
          }],
          hooks: [{
            hookApiVersion: 1,
            id: 'agent.resolvePrerequisites',
            category: 'decision',
            scope: 'agent',
            executionKind: 'decide',
            handler: {
              target: 'plugin',
              exportName: 'resolveTranscriptBinding',
            },
          }],
        },
      })),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.schemaVersion).toBe(2);
    expect('runtime' in result.manifest).toBe(false);
    expect(result.manifest.permissions).toEqual([
      {
        capability: 'network',
        reason: 'Calls the Acme service API',
      },
    ]);
    expect(result.manifest.contributes.agents.map((definition) => definition.id)).toEqual(['acme.backend']);
    expect(result.manifest.contributes.agentRuntimes.map((definition) => definition.id)).toEqual(['acme.backend']);
    expect(result.manifest.contributes.agentRuntimes[0]?.capabilities).toEqual(expectedBackendCapabilities(true));
    expect(result.manifest.contributes.actions.map((definition) => definition.id)).toEqual(['acme.action']);
    expect(result.manifest.contributes.tools.map((definition) => definition.id)).toEqual(['acme.tool']);
        expect(result.manifest.contributes.commands.map((definition) => definition.id)).toEqual(['acme.command']);
        expect(result.manifest.contributes.resources.map((definition) => definition.id)).toEqual(['acme.prompt']);
        expect(result.manifest.contributes.uiDescriptors.map((definition) => definition.id)).toEqual(['acme.status']);
        expect(result.manifest.contributes.hooks.map((definition) => definition.id)).toEqual([
            'agent.resolvePrerequisites',
        ]);
    });

  it('normalizes legacy flat backend execution-run opt-out input to nested capabilities', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify(createBaseManifestV2({
        id: 'acme.execution-run-opt-out',
        uses: ['agents'],
        contributes: {
          agents: [createAgentContribution({
            capabilities: {
              executionRun: false,
            },
          })],
        },
      })),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributes.agentRuntimes[0]?.capabilities).toEqual(expectedBackendCapabilities(false));
  });

  it('accepts manifest-only ACP backends as runtimeCore-backed execution-run capable', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify(createBaseManifestV2({
        id: 'acme.manifest-only-acp',
        uses: ['agents'],
        contributes: {
          agents: [createAgentContribution({
            runtime: {
              kind: 'acp',
              transport: {
                kind: 'stdio',
                launch: {
                  kind: 'executable',
                  command: 'acme-agent',
                },
              },
            },
          })],
        },
      })),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributes.agentRuntimes[0]?.capabilities).toEqual(expectedBackendCapabilities(true));
  });

  it('accepts custom runtimeCore-backed execution-run support without requiring terminal surface handlers', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify(createBaseManifestV2({
        id: 'acme.missing-execution-run-runtime-core',
        uses: ['agents'],
        contributes: {
          agents: [createAgentContribution({
            runtime: {
              kind: 'custom',
            },
          })],
        },
      })),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributes.agentRuntimes[0]?.capabilities).toEqual(expectedBackendCapabilities(true));
  });

  it('does not treat terminal surface handlers as execution-run runtimeCore proof', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify(createBaseManifestV2({
        id: 'acme.malformed-execution-run-runtime-core',
        uses: ['agents'],
        contributes: {
          agents: [createAgentContribution({
            runtime: {
              kind: 'custom',
            },
            capabilities: {
              executionRun: {
                supported: true,
              },
            },
            surfaceHandlers: [
              {
                surfaceApiVersion: 1,
                id: 'backend.terminalRuntime.discoverIdentity',
                kind: 'terminalRuntime',
                operation: 'discoverIdentity',
                handler: {
                  target: 'daemon',
                  exportName: 'discoverIdentity',
                },
              },
            ],
          })],
        },
      })),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributes.agentRuntimes[0]?.surfaceHandlers).toEqual([
      expect.objectContaining({
        kind: 'terminalRuntime',
        operation: 'discoverIdentity',
      }),
    ]);
  });

  it('reads notification contributes into the canonical grouped CLI manifest shape', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.notifications',
        displayName: 'Acme Notifications',
        uses: ['notifications'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [
            {
              capability: 'network',
              reason: 'Delivers Acme notifications through the webhook channel',
            },
          ],
          optional: [],
        },
        contributes: {
          notifications: [
            {
              id: 'acme.notifications.ready',
              kind: 'activity',
              title: 'Ready',
              eventIds: ['ready'],
            },
          ],
          notificationChannels: [
            {
              id: 'acme.notifications.webhook',
              kind: 'webhook',
              title: 'Webhook',
            },
          ],
        },
      })),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.uses).toEqual(['notifications']);
    expect(result.manifest.permissions.map((permission) => permission.capability)).toEqual([
      'network',
    ]);
    expect((result.manifest.contributes.notifications ?? []).map((definition) => definition.id)).toEqual([
      'acme.notifications.ready',
    ]);
    expect((result.manifest.contributes.notificationChannels ?? []).map((definition) => definition.id)).toEqual([
      'acme.notifications.webhook',
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
        contributes: {
          agents: [
            {
              kindVersion: 1,
              id: 'acme.provider',
              display: {
                name: 'Acme Provider',
              },
              ownedBackendIds: [],
            },
          ],
          agentRuntimes: [],
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

  it('infers hook execution kind before manifest validation for final hook registrations', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.hook-compat',
          displayName: 'Hook Compat',
          description: 'Hook registration normalization',
          uses: ['hooks'],
          contributes: {
            hooks: [{
              id: 'agent.resolvePrerequisites',
              category: 'decision',
              scope: 'agent',
              // Intentionally omit executionKind; the compat reader should infer
              // it from the category before schema validation.
              handler: {
                target: 'plugin',
                exportName: 'resolveTranscriptBinding',
              },
            }],
          },
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributes.hooks).toHaveLength(1);
    expect(result.manifest.contributes.hooks[0]).toEqual(
      expect.objectContaining({
        id: 'agent.resolvePrerequisites',
        category: 'decision',
        executionKind: 'decide',
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

  it('accepts executable agent contributions through the final entrypoints shape', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.final-entrypoints',
          displayName: 'Final Entrypoints',
          description: 'Uses the final plugin entrypoints shape',
          uses: ['agents'],
          contributes: {
            agents: [createAgentContribution({
              id: 'acme.final-entrypoints.backend',
              runtime: {
                kind: 'custom',
              },
              surfaceHandlers: [
                {
                  surfaceApiVersion: 1,
                  id: 'backend.externalSession.listCandidates',
                  kind: 'externalSession',
                  operation: 'listCandidates',
                  handler: {
                    target: 'daemon',
                    exportName: 'listCandidates',
                  },
                },
              ],
            })],
          },
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(true);
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
          uses: ['agents'],
          contributes: {
            agents: [
              createAgentContribution({
              id: 'acme.provider',
              display: {
                name: 'Provider',
              },
              }),
              createAgentContribution({
              id: 'acme.provider',
              display: {
                name: 'Provider Duplicate',
              },
              }),
            ],
          },
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/Duplicate agent id/),
      }),
    ]));
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

  it('rejects retired descriptor targets instead of normalizing them', async () => {
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
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
      }),
    ]));
  });

  it('returns a semantic diagnostic when a backend surface handler targets the plugin runtime', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.plugin-runtime-target',
          displayName: 'Plugin Runtime Target',
          description: 'Uses an unsupported backend surface handler handler target',
          uses: ['agents'],
          contributes: {
            agents: [createAgentContribution({
              id: 'acme.plugin-runtime-target.backend',
              runtime: {
                kind: 'custom',
              },
              surfaceHandlers: [
                {
                  surfaceApiVersion: 1,
                  id: 'backend.terminalRuntime.launch',
                  kind: 'terminalRuntime',
                  operation: 'launch',
                  handler: {
                    target: 'plugin',
                    exportName: 'launch',
                  },
                },
              ],
            })],
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
        message: expect.stringMatching(/unsupported handler target/i),
      }),
    ]);
  });

  it('returns a semantic diagnostic when backend surface handler ids are duplicated', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.duplicate-backend-surface-handler',
          displayName: 'Duplicate Backend Surface Handler',
          description: 'Declares duplicate backend surface handler ids',
          uses: ['agents'],
          contributes: {
            agents: [createAgentContribution({
              id: 'acme.duplicate-backend-surface-handler.backend',
              runtime: {
                kind: 'custom',
              },
              surfaceHandlers: [
                {
                  surfaceApiVersion: 1,
                  id: 'backend.terminalRuntime.launch',
                  kind: 'terminalRuntime',
                  operation: 'launch',
                  handler: {
                    target: 'daemon',
                    exportName: 'launch',
                  },
                },
                {
                  surfaceApiVersion: 1,
                  id: 'backend.terminalRuntime.launch',
                  kind: 'terminalRuntime',
                  operation: 'launch',
                  handler: {
                    target: 'daemon',
                    exportName: 'launchAgain',
                  },
                },
              ],
            })],
          },
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/Duplicate backend surface handler id/i),
      }),
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/Duplicate backend surface handler operation/i),
      }),
    ]));
  });

  it('accepts canonical backend surface handler operations even when adapter ids are opaque host-local identifiers', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.backend-surface-handler-operations',
          displayName: 'Backend Surface Handler Operations',
          description: 'Uses canonical backend surface handler operations with opaque ids',
          uses: ['agents'],
          contributes: {
            agents: [createAgentContribution({
              id: 'acme.backend-surface-handler-operations.backend',
              runtime: {
                kind: 'custom',
              },
              surfaceHandlers: [
                {
                  surfaceApiVersion: 1,
                  id: 'launch-adapter',
                  kind: 'terminalRuntime',
                  operation: 'launch',
                  handler: {
                    target: 'daemon',
                    exportName: 'launch',
                  },
                },
              ],
            })],
          },
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
    }));
  });

  it('returns a semantic diagnostic when a backend surface handler operation id is unsupported by the current runtime', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.unsupported-backend-surface-handler-op',
          displayName: 'Unsupported Backend Surface Handler Operation',
          description: 'Declares a backend surface handler operation id that the host does not support',
          uses: ['agents'],
          contributes: {
            agents: [createAgentContribution({
              id: 'acme.unsupported-backend-surface-handler-op.backend',
              runtime: {
                kind: 'custom',
              },
              surfaceHandlers: [
                {
                  surfaceApiVersion: 1,
                  id: 'backend.terminalRuntime.futureOperation',
                  kind: 'terminalRuntime',
                  operation: 'futureOperation',
                  handler: {
                    target: 'daemon',
                    exportName: 'futureOperation',
                  },
                },
              ],
            })],
          },
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/unsupported backend surface operation/i),
      }),
    ]));
  });

  it('returns a semantic diagnostic when backend surface handler kind and operation id do not align', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.mismatched-backend-surface-handler-op',
          displayName: 'Mismatched Backend Surface Handler Operation',
          description: 'Declares a backend surface handler operation id under the wrong backend surface handler kind',
          uses: ['agents'],
          contributes: {
            agents: [createAgentContribution({
              id: 'acme.mismatched-backend-surface-handler-op.backend',
              runtime: {
                kind: 'custom',
              },
              surfaceHandlers: [
                {
                  surfaceApiVersion: 1,
                  id: 'backend.attach.run',
                  kind: 'externalSession',
                  operation: 'run',
                  handler: {
                    target: 'daemon',
                    exportName: 'attach',
                  },
                },
              ],
            })],
          },
        }),
      }),
    );

    const result = await readPluginManifest({ manifestPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/unsupported backend surface operation/i),
      }),
    ]));
  });

  it('returns a semantic diagnostic when the main entrypoint uses an unsupported file extension', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-'));
    const manifestPath = await writeManifestFile(
      pluginRoot,
      JSON.stringify({
        ...createBaseManifestV2({
          id: 'acme.unsupported-daemon-entry-plugin',
          displayName: 'Unsupported Daemon Entry Plugin',
          description: 'Declares a main entrypoint with an unsupported file extension',
          entrypoints: {
            main: './daemon.ts',
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
          uses: ['hooks'],
          contributes: {
            hooks: [{
              hookApiVersion: 1,
              id: 'agent.resolvePrerequisites',
              category: 'decision',
              scope: 'agent',
              executionKind: 'decide',
              handler: {
                target: 'daemon',
                exportName: 'resolveTranscriptBinding',
              },
            }],
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
          uses: ['hooks'],
          contributes: {
            hooks: [{
              hookApiVersion: 2,
              id: 'agent.resolvePrerequisites',
              category: 'decision',
              scope: 'agent',
              executionKind: 'decide',
              handler: {
                target: 'plugin',
                exportName: 'resolveTranscriptBinding',
              },
            }],
          },
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
