import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ResolvedActionContribution, ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { createPluginStateStore } from '@/plugins/store/state';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { executePluginActionIfAvailable } from './execute';

async function writeActionDaemon(rootDir: string): Promise<string> {
  await mkdir(rootDir, { recursive: true });
  const daemonEntryPath = join(rootDir, 'daemon.mjs');
  await writeFile(
    daemonEntryPath,
    [
      'export async function startReview(request) {',
      '  return {',
      '    actionId: request.actionId,',
      '    input: request.input,',
      '    surface: request.context.surface,',
      '    pluginId: request.pluginId,',
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return daemonEntryPath;
}

function createRegistry(action: ResolvedActionContribution): ResolvedContributionRegistry {
  return {
    generationId: 'registry:test',
    providers: [],
    backends: [],
    actions: [action],
    resources: [],
    uiDescriptors: [],
    activationTargets: [],
    hookRegistrations: [],
    actionsById: new Map([[action.definition.id, action]]),
    surfaceHandlersByBackendId: new Map(),
    catalogEntriesById: {},
    providerDefinitionsById: new Map(),
    backendDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: {},
  };
}

function createAction(daemonEntryPath: string): ResolvedActionContribution {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.action.plugin',
    manifestPath: '/plugins/acme/action/plugin.json',
    manifestDigest: 'sha256:action',
    daemonEntryPath,
    sourceSpec: {
      kind: 'path',
      locator: '/plugins/acme/action',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      kindVersion: 1,
      id: 'acme.review.start',
      title: 'Start Acme Review',
      description: 'Starts an Acme review workflow',
      safety: 'safe',
      placements: [],
      slash: null,
      bindings: {
        mcpToolName: 'acme_review_start',
      },
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        session_agent: true,
        mcp: false,
        cli: true,
        rpc: false,
        sdk: false,
      },
      inputHints: null,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      execution: {
        routing: 'daemon',
        handler: {
          target: 'plugin',
          exportName: 'startReview',
        },
      },
    },
  };
}

async function writeActivatedActionPluginFixture(params: Readonly<{
  happyHomeDir: string;
}>): Promise<Readonly<{
  actionId: string;
}>> {
  const pluginId = 'acme.activated.action.plugin';
  const actionId = 'acme.activated.review.start';
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-activated-'));
  const manifestDir = join(pluginRoot, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Activated Action Plugin',
        description: 'Registers an action during daemon activation',
        engines: {
          happier: '^0.2.0',
        },
        runtime: {
          apiVersion: 1,
          capabilities: ['actions'],
        },
        permissions: [
          {
            capability: 'actions.register',
            reason: 'Register an activation-time action for action execution tests',
          },
        ],
        targets: {
          daemon: {
            entry: './daemon.mjs',
          },
        },
        contributes: [],
      }),
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(pluginRoot, 'daemon.mjs'),
    [
      'export async function activate(api) {',
      '  api.registerAction({',
      `    id: ${JSON.stringify(actionId)},`,
      '    title: "Activated Review Start",',
      '    description: "Action from activation-time registration",',
      '    surface: "cli",',
      '    handler: async (request) => ({',
      '      actionId: request.actionId,',
      '      pluginId: request.pluginId,',
      '      surface: request.context.surface,',
      '      input: request.input,',
      '    }),',
      '  });',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const stateStore = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  await stateStore.write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [pluginId]: {
        source: {
          kind: 'path',
          locator: pluginRoot,
          trustPolicy: 'local_trusted',
          installPolicy: 'link',
          resolvedPath: pluginRoot,
          manifestPath: join(manifestDir, 'plugin.json'),
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

  return { actionId };
}

async function writeManifestActionPluginFixture(params: Readonly<{
  happyHomeDir: string;
}>): Promise<Readonly<{
  actionId: string;
}>> {
  const pluginId = 'acme.manifest.action.plugin';
  const actionId = 'acme.manifest.review.start';
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-manifest-'));
  const manifestDir = join(pluginRoot, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Manifest Action Plugin',
        description: 'Executes a manifest-declared action from a plugin daemon export',
        engines: {
          happier: '^0.2.0',
        },
        runtime: {
          apiVersion: 1,
          capabilities: ['actions'],
        },
        permissions: [],
        targets: {
          daemon: {
            entry: './daemon.mjs',
          },
        },
        contributes: [
          {
            kind: 'action',
            id: actionId,
            title: 'Manifest Review Start',
            description: 'Manifest-defined plugin action',
            scopes: ['global'],
            surfaces: ['cli'],
            placement: 'commandPalette',
            dangerLevel: 'safe',
            handler: {
              target: 'daemon',
              exportName: 'startManifestReview',
            },
          },
        ],
      }),
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(pluginRoot, 'daemon.mjs'),
    [
      'export async function startManifestReview(request) {',
      '  return {',
      '    actionId: request.actionId,',
      '    pluginId: request.pluginId,',
      '    surface: request.context.surface,',
      '    input: request.input,',
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const stateStore = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  await stateStore.write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [pluginId]: {
        source: {
          kind: 'path',
          locator: pluginRoot,
          trustPolicy: 'local_trusted',
          installPolicy: 'link',
          resolvedPath: pluginRoot,
          manifestPath: join(manifestDir, 'plugin.json'),
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

  return { actionId };
}

describe('executePluginActionIfAvailable', () => {
  it('executes a daemon-backed plugin action and normalizes the result', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-exec-'));
    const daemonEntryPath = await writeActionDaemon(pluginRoot);
    const action = createAction(daemonEntryPath);

    const result = await executePluginActionIfAvailable({
      registry: createRegistry(action),
      actionId: 'acme.review.start',
      input: { scope: 'diff' },
      context: {
        defaultSessionId: 'sess-1',
        surface: 'cli',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          actionId: 'acme.review.start',
          input: {
            scope: 'diff',
          },
          pluginId: 'acme.action.plugin',
          surface: 'cli',
        },
      },
    });
  });

  it('fails closed when a plugin action is not declared for the requested surface', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-exec-'));
    const daemonEntryPath = await writeActionDaemon(pluginRoot);

    const result = await executePluginActionIfAvailable({
      registry: createRegistry(createAction(daemonEntryPath)),
      actionId: 'acme.review.start',
      input: {},
      context: {
        defaultSessionId: 'sess-1',
        surface: 'mcp',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_unavailable',
        error: 'Plugin action is not available on the requested surface',
      },
    });
  });

  it('executes activation-time plugin actions from the authoritative runtime registry when resolving from happyHomeDir', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-action-home-'));
    const { actionId } = await writeActivatedActionPluginFixture({ happyHomeDir });

    const result = await executePluginActionIfAvailable({
      happyHomeDir,
      actionId,
      input: { scope: 'runtime' },
      context: {
        defaultSessionId: 'sess-1',
        surface: 'cli',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          actionId,
          input: {
            scope: 'runtime',
          },
          pluginId: 'acme.activated.action.plugin',
          surface: 'cli',
        },
      },
    });
  });

  it('executes manifest-declared schema-version-1 plugin actions when resolving from happyHomeDir', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-action-manifest-home-'));
    const { actionId } = await writeManifestActionPluginFixture({ happyHomeDir });

    const result = await executePluginActionIfAvailable({
      happyHomeDir,
      actionId,
      input: { scope: 'manifest' },
      context: {
        defaultSessionId: 'sess-1',
        surface: 'cli',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          actionId,
          input: {
            scope: 'manifest',
          },
          pluginId: 'acme.manifest.action.plugin',
          surface: 'cli',
        },
      },
    });
  });

  it('executes the reload-helper authoring example action after the plugin is installed and reloaded', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-helper-home-'));
    const pluginRoot = fileURLToPath(new URL('../../testkit/fixtures/authoring-examples/reload-helper-plugin/', import.meta.url));
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const stateStore = createPluginStateStore({ happyHomeDir });

    await stateStore.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'examples.reload-helper-plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath,
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '0.1.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await executePluginActionIfAvailable({
      happyHomeDir,
      actionId: 'examples.reload.report',
      input: {},
      context: {
        surface: 'cli',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          ok: true,
          data: {
            activatedAtMs: expect.any(Number),
          },
        },
      },
    });
  });
});
