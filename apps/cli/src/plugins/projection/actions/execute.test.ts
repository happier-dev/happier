import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
  ResolvedActionContribution,
  ResolvedCommandContribution,
  ResolvedContributionRegistry,
  ResolvedToolContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
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
      '    ok: true,',
      '    data: {',
      '      actionId: request.actionId,',
      '      input: request.input,',
      '      surface: request.context.surface,',
      '      pluginId: request.pluginId,',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return daemonEntryPath;
}

async function writeActionDaemonWithReturn(rootDir: string, returnExpression: string): Promise<string> {
  await mkdir(rootDir, { recursive: true });
  const daemonEntryPath = join(rootDir, 'daemon.mjs');
  await writeFile(
    daemonEntryPath,
    [
      'export async function startReview(request) {',
      `  return ${returnExpression};`,
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return daemonEntryPath;
}

function createRegistry(
  action: ResolvedActionContribution,
  options: Readonly<{
    commands?: readonly ResolvedCommandContribution[];
    tools?: readonly ResolvedToolContribution[];
  }> = {},
): ResolvedContributionRegistry {
  const commands = options.commands ?? [];
  const tools = options.tools ?? [];
  return {
    generationId: 'registry:test',
    agents: [],
    agentRuntimes: [],
    actions: [action],
    commands,
    tools,
    resources: [],
    uiDescriptors: [],
    activationTargets: [],
    hookRegistrations: [],
    actionsById: new Map([[action.definition.id, action]]),
    commandsById: new Map(commands.map((command) => [command.definition.id, command])),
    toolsById: new Map(tools.map((tool) => [tool.definition.id, tool])),
    surfaceHandlersByBackendId: new Map(),
    catalogEntriesById: {},
    agentDefinitionsById: new Map(),
    agentRuntimeDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: {},
  };
}

function createAction(
  daemonEntryPath: string,
  actionId = 'acme.review.start',
): ResolvedActionContribution {
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
      id: actionId,
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
        agent: true,
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

function createCommandContribution(
  action: ResolvedActionContribution,
  commandId: string,
): ResolvedCommandContribution {
  return {
    provenance: action.provenance,
    source: action.source,
    pluginId: action.pluginId,
    manifestPath: action.manifestPath,
    manifestDigest: action.manifestDigest,
    daemonEntryPath: action.daemonEntryPath,
    sourceSpec: action.sourceSpec,
    definition: {
      kindVersion: 1,
      id: commandId,
      command: 'acme',
      rootHelpLabel: 'Acme',
      allowTmux: false,
      actionId: action.definition.id,
    },
  };
}

function createToolContribution(
  action: ResolvedActionContribution,
  toolId: string,
): ResolvedToolContribution {
  return {
    provenance: action.provenance,
    source: action.source,
    pluginId: action.pluginId,
    manifestPath: action.manifestPath,
    manifestDigest: action.manifestDigest,
    daemonEntryPath: action.daemonEntryPath,
    sourceSpec: action.sourceSpec,
    definition: {
      kindVersion: 1,
      id: toolId,
      name: toolId,
      title: 'Acme Tool',
      description: 'Runs Acme through a tool contribution',
      safety: action.definition.safety,
      surfaces: {
        cli: true,
        mcp: true,
        agent: true,
      },
      actionId: action.definition.id,
    },
  };
}

function createExecutableRegistry(params: Readonly<{
  action: ResolvedActionContribution;
  commands?: readonly ResolvedCommandContribution[];
  tools?: readonly ResolvedToolContribution[];
  handler?: ResolvedExecutablePluginRuntimeRegistry['actionHandlersByActionId'] extends ReadonlyMap<string, infer Handler> ? Handler : never;
  activatePluginsByEvent: ResolvedExecutablePluginRuntimeRegistry['activatePluginsByEvent'];
}>): ResolvedExecutablePluginRuntimeRegistry {
  const handler = params.handler ?? (async (request) => ({
    ok: true,
    data: {
      actionId: request.actionId,
      input: request.input,
      pluginId: request.pluginId,
      surface: request.context.surface,
    },
  }));
  const contributes = createRegistry(params.action, {
    commands: params.commands,
    tools: params.tools,
  });

  return {
    contributes: contributes as ResolvedExecutablePluginRuntimeRegistry['contributes'],
    actionHandlersByActionId: new Map([[params.action.definition.id, handler]]),
    hookHandlersByHookId: new Map(),
    runtimeCoreHandlersByBackendId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: {},
    activatedPluginIds: new Set(),
    activatePluginsByEvent: params.activatePluginsByEvent,
    readHookEventEnvelopeV1,
    dispose: async () => {},
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
        uses: ['actions'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [],
          optional: [],
        },
        contributes: {
          actions: [
            {
              id: actionId,
              title: 'Activated Review Start',
              description: 'Action from activation-time handler binding',
              scopes: ['global'],
              surfaces: ['cli'],
              placement: 'commandPalette',
              dangerLevel: 'safe',
              handler: {
                target: 'daemon',
                registrationId: actionId,
              },
            },
          ],
        },
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
      '    handler: async (request) => ({',
      '      ok: true,',
      '      data: {',
      '        actionId: request.actionId,',
      '        pluginId: request.pluginId,',
      '        surface: request.context.surface,',
      '        input: request.input,',
      '      },',
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
        uses: ['actions'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [],
          optional: [],
        },
        contributes: {
          actions: [
            {
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
        },
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
      '    ok: true,',
      '    data: {',
      '      actionId: request.actionId,',
      '      pluginId: request.pluginId,',
      '      surface: request.context.surface,',
      '      input: request.input,',
      '    },',
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

async function writeManifestToolPluginFixture(params: Readonly<{
  happyHomeDir: string;
}>): Promise<Readonly<{
  toolId: string;
}>> {
  const pluginId = 'acme.manifest.tool.plugin';
  const toolId = 'acme.manifest.review.tool';
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-tool-manifest-'));
  const manifestDir = join(pluginRoot, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Manifest Tool Plugin',
        description: 'Executes a manifest-declared tool from a plugin daemon export',
        engines: {
          happier: '^0.2.0',
        },
        uses: ['tools'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [],
          optional: [],
        },
        contributes: {
          tools: [
            {
              id: toolId,
              name: 'acme_manifest_review_tool',
              title: 'Manifest Review Tool',
              description: 'Manifest-defined plugin tool',
              safety: 'safe',
              surfaces: ['cli', 'agent'],
              inputSchema: {
                type: 'object',
                additionalProperties: true,
              },
              handler: {
                target: 'daemon',
                exportName: 'runManifestTool',
              },
            },
          ],
        },
      }),
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(pluginRoot, 'daemon.mjs'),
    [
      'export async function runManifestTool(request) {',
      '  return {',
      '    ok: true,',
      '    data: {',
      '      actionId: request.actionId,',
      '      pluginId: request.pluginId,',
      '      surface: request.context.surface,',
      '      input: request.input,',
      '    },',
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

  return { toolId };
}

async function writeActivationMarkerPluginFixture(params: Readonly<{
  happyHomeDir: string;
  markerPath: string;
}>): Promise<void> {
  const pluginId = 'acme.activation.marker.plugin';
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-marker-'));
  const manifestDir = join(pluginRoot, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Activation Marker Plugin',
        description: 'Marks activation for plugin action dispatch tests',
        engines: {
          happier: '^0.2.0',
        },
        uses: ['actions'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [],
          optional: [],
        },
        contributes: {},
      }),
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(pluginRoot, 'daemon.mjs'),
    [
      'import { writeFileSync } from "node:fs";',
      'export async function activate() {',
      `  writeFileSync(${JSON.stringify(params.markerPath)}, "activated\\n", "utf8");`,
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

  it('activates an onCommand owner before executing a command-backed action handler', async () => {
    const action = createAction('/unused/daemon.mjs', 'acme.action.start');
    const activationEvents: string[] = [];
    const registry = createExecutableRegistry({
      action,
      commands: [createCommandContribution(action, 'acme.command.start')],
      activatePluginsByEvent: async (activationEvent) => {
        activationEvents.push(activationEvent);
        return [{ pluginId: action.pluginId ?? '', diagnostics: [] }];
      },
    });

    const result = await executePluginActionIfAvailable({
      runtimeRegistry: registry,
      actionId: action.definition.id,
      input: { scope: 'command' },
      context: {
        surface: 'cli',
      },
    });

    expect(activationEvents).toEqual(['onCommand:acme.command.start']);
    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          actionId: 'acme.action.start',
          input: {
            scope: 'command',
          },
          pluginId: 'acme.action.plugin',
          surface: 'cli',
        },
      },
    });
  });

  it('activates an onTool owner before executing a tool-backed action handler', async () => {
    const action = createAction('/unused/daemon.mjs', 'acme.action.inspect');
    const activationEvents: string[] = [];
    const registry = createExecutableRegistry({
      action,
      tools: [createToolContribution(action, 'acme.tool.inspect')],
      activatePluginsByEvent: async (activationEvent) => {
        activationEvents.push(activationEvent);
        return [{ pluginId: action.pluginId ?? '', diagnostics: [] }];
      },
    });

    const result = await executePluginActionIfAvailable({
      runtimeRegistry: registry,
      actionId: action.definition.id,
      input: { scope: 'tool' },
      context: {
        surface: 'cli',
      },
    });

    expect(activationEvents).toEqual(['onTool:acme.tool.inspect']);
    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          actionId: 'acme.action.inspect',
          input: {
            scope: 'tool',
          },
          pluginId: 'acme.action.plugin',
          surface: 'cli',
        },
      },
    });
  });

  it('returns activation diagnostics before invoking an action handler when lazy activation fails', async () => {
    const action = createAction('/unused/daemon.mjs', 'acme.action.fail');
    const handler = vi.fn(async () => ({ ok: true as const, data: null }));
    const registry = createExecutableRegistry({
      action,
      handler,
      activatePluginsByEvent: async () => [{
        pluginId: action.pluginId ?? '',
        diagnostics: [{
          code: 'plugin_activation_failed',
          message: 'Activation failed for Acme',
        }],
      }],
    });

    const result = await executePluginActionIfAvailable({
      runtimeRegistry: registry,
      actionId: action.definition.id,
      input: {},
      context: {
        surface: 'cli',
      },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_activation_failed',
        error: 'Activation failed for Acme',
      },
    });
  });

  it('unwraps public plugin action success envelopes and validates data against resultSchema', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-result-schema-'));
    const daemonEntryPath = await writeActionDaemonWithReturn(
      pluginRoot,
      '({ ok: true, data: { summary: "ready" } })',
    );
    const action = {
      ...createAction(daemonEntryPath),
      definition: {
        ...createAction(daemonEntryPath).definition,
        outputSchema: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    };

    const result = await executePluginActionIfAvailable({
      registry: createRegistry(action),
      actionId: 'acme.review.start',
      input: { scope: 'diff' },
      context: {
        surface: 'cli',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          summary: 'ready',
        },
      },
    });
  });

  it('fails closed before invoking a plugin action when input does not match inputSchema', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-input-schema-invalid-'));
    const daemonEntryPath = await writeActionDaemon(pluginRoot);
    const baseAction = createAction(daemonEntryPath);
    const action: ResolvedActionContribution = {
      ...baseAction,
      definition: {
        ...baseAction.definition,
        inputSchema: {
          type: 'object',
          required: ['scope'],
          properties: {
            scope: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    };

    const result = await executePluginActionIfAvailable({
      registry: createRegistry(action),
      actionId: 'acme.review.start',
      input: { scope: 123 },
      context: {
        surface: 'cli',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_input_schema_invalid',
        error: 'Plugin action input does not match its manifest inputSchema',
      },
    });
  });

  it('fails closed when a plugin action success payload does not match resultSchema', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-result-schema-invalid-'));
    const daemonEntryPath = await writeActionDaemonWithReturn(
      pluginRoot,
      '({ ok: true, data: { summary: 123 } })',
    );
    const baseAction = createAction(daemonEntryPath);
    const action: ResolvedActionContribution = {
      ...baseAction,
      definition: {
        ...baseAction.definition,
        outputSchema: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    };

    const result = await executePluginActionIfAvailable({
      registry: createRegistry(action),
      actionId: 'acme.review.start',
      input: { scope: 'diff' },
      context: {
        surface: 'cli',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_result_schema_invalid',
        error: 'Plugin action returned data that does not match its manifest resultSchema',
      },
    });
  });

  it('normalizes public plugin action failure envelopes without throwing raw errors', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-result-failure-'));
    const daemonEntryPath = await writeActionDaemonWithReturn(
      pluginRoot,
      '({ ok: false, error: { code: "acme_not_ready", message: "Acme is not ready", retryable: true } })',
    );

    const result = await executePluginActionIfAvailable({
      registry: createRegistry(createAction(daemonEntryPath)),
      actionId: 'acme.review.start',
      input: { scope: 'diff' },
      context: {
        surface: 'cli',
      },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'acme_not_ready',
        error: 'Acme is not ready',
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

  it('executes manifest-declared plugin actions when resolving from happyHomeDir', async () => {
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

  it('executes synthetic actions generated from manifest-declared static tool handlers', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-tool-manifest-home-'));
    const { toolId } = await writeManifestToolPluginFixture({ happyHomeDir });

    const result = await executePluginActionIfAvailable({
      happyHomeDir,
      actionId: toolId,
      input: { scope: 'manifest-tool' },
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
          actionId: toolId,
          input: {
            scope: 'manifest-tool',
          },
          pluginId: 'acme.manifest.tool.plugin',
          surface: 'cli',
        },
      },
    });
  });

  it('does not activate plugin runtime while checking built-in action ids', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-action-builtin-home-'));
    const markerPath = join(happyHomeDir, 'activation-marker.txt');
    await writeActivationMarkerPluginFixture({ happyHomeDir, markerPath });

    const result = await executePluginActionIfAvailable({
      happyHomeDir,
      actionId: 'session.list',
      input: { limit: 2 },
      context: {
        surface: 'cli',
      },
    });

    expect(result).toEqual({ matched: false });
    expect(existsSync(markerPath)).toBe(false);
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
          activatedAtMs: expect.any(Number),
        },
      },
    });
  });
});
