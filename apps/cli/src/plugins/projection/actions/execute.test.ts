import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
  ResolvedActionContribution,
  ResolvedActionDefinition,
  ResolvedCommandContribution,
  ResolvedContributionRegistry,
  ResolvedToolContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createTargetActionInvocationRegistry as createTargetActionInvocationRegistryBase } from '@/plugins/runtime/invocation/targetActionRegistry';
import type { TargetActionInvocationRegistration } from '@/plugins/runtime/invocation/targetActionRegistry';
import { executePluginActionIfAvailable } from './execute';

type SafeResolvedActionContribution = Omit<ResolvedActionContribution, 'definition'> & Readonly<{
  definition: Extract<ResolvedActionDefinition, Readonly<{ dangerLevel: 'safe' }>>;
}>;

function createTargetActionInvocationRegistry(
  params: Omit<Parameters<typeof createTargetActionInvocationRegistryBase>[0], 'createServices' | 'resolveHostBinding' | 'resolveAuthorizationFacts'>
    & Partial<Pick<Parameters<typeof createTargetActionInvocationRegistryBase>[0], 'resolveAuthorizationFacts'>>,
) {
  return createTargetActionInvocationRegistryBase({
    resolveAuthorizationFacts: (action) => ({
      packageTrust: {
        packageIdentity: action.qualifiedId,
        reviewedPackageIdentity: action.qualifiedId,
      },
      generation: {
        targetGeneration: action.generation,
        desiredGeneration: action.generation,
        appliedGeneration: action.generation,
      },
      resourceSelections: [],
      scopedGrants: [],
      operatingSystemAuthorization: [],
    }),
    resolveHostBinding: createTargetActionHostBindingResolver(),
    createServices: createUnavailablePluginServicesFactory(),
    ...params,
  });
}

function createTargetActionRegistration(params: Readonly<{
  action: ResolvedActionContribution;
  handler: TargetActionInvocationRegistration['handler'];
}>): TargetActionInvocationRegistration {
  return {
    pluginId: params.action.pluginId ?? '',
    pluginVersion: '1.0.0',
    generation: '7',
    localId: params.action.definition.id,
    definition: {
      id: params.action.definition.id,
      dangerLevel: 'safe',
      scopes: ['global'],
      surfaces: Object.entries(params.action.definition.surfaces)
        .filter(([, enabled]) => enabled === true)
        .map(([surface]) => surface),
      ...(params.action.definition.inputSchema ? { inputSchema: params.action.definition.inputSchema } : {}),
      ...(params.action.definition.outputSchema ? { resultSchema: params.action.definition.outputSchema } : {}),
    },
    handler: params.handler,
  };
}

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
    uiViewsV2: [],
    uiRenderersV2: [],
    uiTranslationsV2: [],
    agents: [],
        actions: [action],
    commands,
    tools,
    resources: [],
    activationTargets: [],
    actionsById: new Map([[action.definition.id, action]]),
    commandsById: new Map(commands.map((command) => [command.definition.id, command])),
    toolsById: new Map(tools.map((tool) => [tool.definition.id, tool])),
        catalogEntriesById: {},
    agentDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
  };
}

function createAction(
  daemonEntryPath: string,
  actionId = 'acme.review.start',
): SafeResolvedActionContribution {
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
      scopes: ['global'],
      contributionSurfaces: ['cli', 'agent'],
      placement: 'commandPalette',
      dangerLevel: 'safe',
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
      title: 'Acme',
      path: ['acme'],
      action: action.definition.id,
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
      surfaces: ['cli', 'mcp', 'agent'],
      action: action.definition.id,
      actionId: action.definition.id,
    },
  };
}

function createExecutableRegistry(params: Readonly<{
  action: ResolvedActionContribution;
  commands?: readonly ResolvedCommandContribution[];
  tools?: readonly ResolvedToolContribution[];
  targetActionInvocations?: ReturnType<typeof createTargetActionInvocationRegistry>;
  activateContributionsOnDemand: ResolvedExecutablePluginRuntimeRegistry['activateContributionsOnDemand'];
}>): ResolvedExecutablePluginRuntimeRegistry {
  const contributes = createRegistry(params.action, {
    commands: params.commands,
    tools: params.tools,
  });

  return {
    contributes: contributes as ResolvedExecutablePluginRuntimeRegistry['contributes'],
    generation: 7,
    targetActionInvocations: params.targetActionInvocations,
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: {},
    activatedPluginIds: new Set(),
    activateContributionsOnDemand: params.activateContributionsOnDemand,
    createAgentInvocationServices: () => createUnavailablePluginServices(),
    resolvePromptAssetBlocks: async () => [],
    readHookEventEnvelopeV1,
    retireConsumers: () => {},
    dispose: async () => {},
  };
}

describe('executePluginActionIfAvailable', () => {
  it('executes a first-party plugin action through the same qualified target-action route', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'mint-client-auth');
    const action: ResolvedActionContribution = {
      ...externalAction,
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: {
        ...externalAction.definition,
        dangerLevel: 'safe',
        scopes: ['settings'],
        surfaces: {
          ...externalAction.definition.surfaces,
          cli: false,
          ui: true,
        },
        contributionSurfaces: ['ui'],
      },
    };
    const target = vi.fn(async () => ({ status: 'minted' }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [{
        pluginId: 'acme.action.plugin',
        pluginVersion: '1.0.0',
        generation: '7',
        localId: 'mint-client-auth',
        definition: {
          id: 'mint-client-auth',
          dangerLevel: 'safe',
          scopes: ['settings'],
          surfaces: ['ui'],
        },
        handler: target,
      }],
    });
    const baseRegistry = createExecutableRegistry({
      action,
      targetActionInvocations,
      activateContributionsOnDemand: async () => [],
    });
    const registry: ResolvedExecutablePluginRuntimeRegistry = {
      ...baseRegistry,
      contributes: {
        ...baseRegistry.contributes,
        actionsById: new Map([['acme.action.plugin/mint-client-auth', action]]),
      },
    };

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: registry,
      actionId: 'acme.action.plugin/mint-client-auth',
      input: {},
      context: { surface: 'ui' },
    })).resolves.toEqual({
      matched: true,
      result: { ok: true, result: { status: 'minted' } },
    });
    expect(target).toHaveBeenCalledTimes(1);
  });

  it('executes one committed target action invocation', async () => {
    const action: ResolvedActionContribution = {
      ...createAction('/unused/daemon.mjs', 'run'),
      pluginId: 'acme.action.plugin',
      definition: {
        ...createAction('/unused/daemon.mjs', 'run').definition,
        dangerLevel: 'safe',
        scopes: ['global'],
        contributionSurfaces: ['cli'],
      },
    };
    const target = vi.fn(async () => ({ executedBy: 'target' }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [{
        pluginId: 'acme.action.plugin', pluginVersion: '1.0.0', generation: '7', localId: 'run',
        definition: {
          id: 'run', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'],
          resultSchema: { type: 'object', required: ['executedBy'], properties: { executedBy: { const: 'target' } } },
        },
        handler: target,
      }],
    });
    const registry = createExecutableRegistry({
      action,
      targetActionInvocations,
      activateContributionsOnDemand: async () => [],
    });

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: registry, actionId: 'run', input: {}, context: { surface: 'cli' },
    })).resolves.toEqual({ matched: true, result: { ok: true, result: { executedBy: 'target' } } });
    expect(target).toHaveBeenCalledTimes(1);
  });

  it('returns the committed target failure', async () => {
    const action: ResolvedActionContribution = {
      ...createAction('/unused/daemon.mjs', 'run'),
      definition: {
        ...createAction('/unused/daemon.mjs', 'run').definition,
        dangerLevel: 'safe', scopes: ['global'], contributionSurfaces: ['cli'],
      },
    };
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [{
        pluginId: 'acme.action.plugin', pluginVersion: '1.0.0', generation: '7', localId: 'run',
        definition: { id: 'run', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'] },
        handler: async () => { throw new Error('target failed'); },
      }],
    });
    const registry = createExecutableRegistry({ action, targetActionInvocations, activateContributionsOnDemand: async () => [] });

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: registry, actionId: 'run', input: {}, context: { surface: 'cli' },
    })).resolves.toMatchObject({ matched: true, result: { ok: false, errorCode: 'plugin_action_execution_failed' } });
  });

  it('returns target result validation failures', async () => {
    const action: ResolvedActionContribution = {
      ...createAction('/unused/daemon.mjs', 'run'),
      definition: {
        ...createAction('/unused/daemon.mjs', 'run').definition,
        dangerLevel: 'safe', scopes: ['global'], contributionSurfaces: ['cli'],
      },
    };
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [{
        pluginId: 'acme.action.plugin', pluginVersion: '1.0.0', generation: '7', localId: 'run',
        definition: {
          id: 'run', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'],
          resultSchema: { type: 'object', required: ['owner'], properties: { owner: { const: 'target' } } },
        },
        handler: async () => ({ wrong: true }),
      }],
    });
    const registry = createExecutableRegistry({
      action, targetActionInvocations, activateContributionsOnDemand: async () => [],
    });

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: registry, actionId: 'run', input: {}, context: { surface: 'cli' },
    })).resolves.toMatchObject({
      matched: true,
      result: { ok: false, errorCode: 'plugin_action_result_schema_invalid' },
    });
  });

  it('rejects non-JSON plugin action results even when no output schema is declared', async () => {
    const action = createAction('/unused/daemon.mjs', 'non-json-result');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Deliberately cross the SDK result type to exercise the runtime boundary.
    const handler = vi.fn(async () => cyclic as never);
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler })],
    });
    const registry = createExecutableRegistry({
      action,
      targetActionInvocations,
      activateContributionsOnDemand: async () => [],
    });

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: registry,
      actionId: action.definition.id,
      input: {},
      context: { surface: 'cli' },
    })).resolves.toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_result_schema_invalid',
        error: 'Plugin action result must be JSON-safe',
      },
    });
  });

  it('fails closed when a declared target action is still unbound', async () => {
    const action: ResolvedActionContribution = {
      ...createAction('/unused/daemon.mjs', 'run'),
      definition: {
        ...createAction('/unused/daemon.mjs', 'run').definition,
        dangerLevel: 'safe', scopes: ['global'], contributionSurfaces: ['cli'],
      },
    };
    const activateContributionsOnDemand = vi.fn(async () => []);
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [], expectedActions: [{ pluginId: 'acme.action.plugin', localId: 'run' }],
    });
    const registry = createExecutableRegistry({
      action, targetActionInvocations, activateContributionsOnDemand,
    });

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: registry, actionId: 'run', input: {}, context: { surface: 'cli' },
    })).resolves.toMatchObject({
      matched: true,
      result: { ok: false, errorCode: 'plugin_action_handler_missing' },
    });
    expect(activateContributionsOnDemand).toHaveBeenCalledWith([{
      pluginId: 'acme.action.plugin',
      family: 'actions',
      localId: 'run',
    }]);
  });

  it('requires qualified identity when two target plugins publish the same local action id', async () => {
    const alpha = { ...createAction('/unused/a.mjs', 'run'), pluginId: 'acme.alpha' };
    const beta = { ...createAction('/unused/b.mjs', 'run'), pluginId: 'acme.beta' };
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [
        { pluginId: 'acme.alpha', pluginVersion: '1', generation: '7', localId: 'run', definition: { id: 'run', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'] }, handler: async () => ({ owner: 'alpha' }) },
        { pluginId: 'acme.beta', pluginVersion: '1', generation: '7', localId: 'run', definition: { id: 'run', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'] }, handler: async () => ({ owner: 'beta' }) },
      ],
    });
    const base = createExecutableRegistry({ action: alpha, targetActionInvocations, activateContributionsOnDemand: async () => [] });
    const contributes = {
      ...base.contributes,
      actions: [alpha, beta],
      actionsById: new Map([['acme.alpha/run', alpha], ['acme.beta/run', beta]]),
    };
    const runtimeRegistry = { ...base, contributes };

    await expect(executePluginActionIfAvailable({ runtimeRegistry, actionId: 'acme.beta/run', input: {}, context: { surface: 'cli' } }))
      .resolves.toEqual({ matched: true, result: { ok: true, result: { owner: 'beta' } } });
    await expect(executePluginActionIfAvailable({ runtimeRegistry, actionId: 'run', input: {}, context: { surface: 'cli' } }))
      .resolves.toEqual({ matched: false });
  });

  it('does not turn a globally supplied local action id into authority even when only one plugin matches', async () => {
    const action = { ...createAction('/unused/a.mjs', 'run'), pluginId: 'acme.alpha' };
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [{
        pluginId: 'acme.alpha', pluginVersion: '1', generation: '7', localId: 'run',
        definition: { id: 'run', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'] },
        handler: async () => ({ owner: 'alpha' }),
      }],
    });
    const base = createExecutableRegistry({ action, targetActionInvocations, activateContributionsOnDemand: async () => [] });
    const runtimeRegistry = {
      ...base,
      contributes: { ...base.contributes, actionsById: new Map([['acme.alpha/run', action]]) },
    };

    await expect(executePluginActionIfAvailable({ runtimeRegistry, actionId: 'run', input: {}, context: { surface: 'cli' } }))
      .resolves.toEqual({ matched: false });
    await expect(executePluginActionIfAvailable({ runtimeRegistry, actionId: 'acme.alpha/run', input: {}, context: { surface: 'cli' } }))
      .resolves.toEqual({ matched: true, result: { ok: true, result: { owner: 'alpha' } } });
  });

  it('does not import a daemon module to resolve an unbound static action export', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-exec-'));
    const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
    await writeFile(daemonEntryPath, 'throw new Error("static action module must not be imported");\n', 'utf8');
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
        ok: false,
        errorCode: 'plugin_action_handler_missing',
        error: 'Plugin action is not bound through named activation',
      },
    });
  });

  it('activates the executable action registration behind a command contribution', async () => {
    const action = createAction('/unused/daemon.mjs', 'acme.action.start');
    const activationDemands: unknown[] = [];
    let targetActions: TargetActionInvocationRegistration[] = [];
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: targetActions,
      expectedActions: [{ pluginId: 'acme.action.plugin', localId: action.definition.id }],
      readActions: () => targetActions,
    });
    const registry = createExecutableRegistry({
      action,
      commands: [createCommandContribution(action, 'acme.command.start')],
      targetActionInvocations,
      activateContributionsOnDemand: async (demands) => {
        activationDemands.push(...demands);
        targetActions = [createTargetActionRegistration({
          action,
          handler: async (input, context) => ({
            actionId: action.definition.id,
            input,
            pluginId: context.plugin.id,
            surface: context.surface ?? 'cli',
          }),
        })];
        targetActionInvocations.refresh();
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

    expect(activationDemands).toEqual([{
      pluginId: 'acme.action.plugin',
      family: 'actions',
      localId: 'acme.action.start',
    }]);
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

  it('activates the executable action registration behind a tool contribution', async () => {
    const action = createAction('/unused/daemon.mjs', 'acme.action.inspect');
    const activationDemands: unknown[] = [];
    let targetActions: TargetActionInvocationRegistration[] = [];
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: targetActions,
      expectedActions: [{ pluginId: 'acme.action.plugin', localId: action.definition.id }],
      readActions: () => targetActions,
    });
    const registry = createExecutableRegistry({
      action,
      tools: [createToolContribution(action, 'acme.tool.inspect')],
      targetActionInvocations,
      activateContributionsOnDemand: async (demands) => {
        activationDemands.push(...demands);
        targetActions = [createTargetActionRegistration({
          action,
          handler: async (input, context) => ({
            actionId: action.definition.id,
            input,
            pluginId: context.plugin.id,
            surface: context.surface ?? 'cli',
          }),
        })];
        targetActionInvocations.refresh();
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

    expect(activationDemands).toEqual([{
      pluginId: 'acme.action.plugin',
      family: 'actions',
      localId: 'acme.action.inspect',
    }]);
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
    const handler = vi.fn(async () => null);
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [],
      expectedActions: [{ pluginId: 'acme.action.plugin', localId: action.definition.id }],
    });
    const registry = createExecutableRegistry({
      action,
      targetActionInvocations,
      activateContributionsOnDemand: async () => [{
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

  it('uses the committed target action generation instead of stale sourceSpec trust metadata', async () => {
    const trustedAction = createAction('/unused/daemon.mjs', 'acme.action.untrusted');
    const action: ResolvedActionContribution = {
      ...trustedAction,
      sourceSpec: {
        ...trustedAction.sourceSpec!,
        kind: 'path',
        trustPolicy: 'prompt',
      },
    };
    const handler = vi.fn(async () => ({ ok: true as const, data: null }));
    const activateContributionsOnDemand = vi.fn(async () => [{ pluginId: action.pluginId ?? '', diagnostics: [] }]);
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler })],
    });
    const registry = createExecutableRegistry({ action, targetActionInvocations, activateContributionsOnDemand });

    const result = await executePluginActionIfAvailable({
      runtimeRegistry: registry,
      actionId: action.definition.id,
      input: {},
      context: { surface: 'cli' },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(activateContributionsOnDemand).not.toHaveBeenCalled();
    expect(result).toEqual({
      matched: true,
      result: { ok: true, result: { ok: true, data: null } },
    });
  });

  it('fails closed before invoking a plugin action when input does not match inputSchema', async () => {
    const baseAction = createAction('/unused/daemon.mjs', 'run');
    const action: ResolvedActionContribution = {
      ...baseAction,
      definition: {
        ...baseAction.definition,
        dangerLevel: 'safe',
        scopes: ['global'],
        contributionSurfaces: ['cli'],
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
    const handler = vi.fn(async () => ({ ok: true }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [{
        pluginId: 'acme.action.plugin', pluginVersion: '1.0.0', generation: '7', localId: 'run',
        definition: {
          id: 'run', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'],
          inputSchema: action.definition.inputSchema,
        },
        handler,
      }],
    });

    const result = await executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: 'run',
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
    expect(handler).not.toHaveBeenCalled();
  });

  it('validates null-prototype JSON enum inputs and const results without throwing', async () => {
    const baseAction = createAction('/unused/daemon.mjs', 'safe-json');
    const action: ResolvedActionContribution = {
      ...baseAction,
      definition: {
        ...baseAction.definition,
        inputSchema: {
          type: 'object',
          required: ['selection'],
          properties: {
            selection: {
              enum: [{ valueOf: 'literal', nested: [{ enabled: true }], amount: 4 }],
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          const: { valueOf: 'result', nested: [{ accepted: true }], amount: 4 },
        },
      },
    };
    const selection = Object.assign(Object.create(null) as Record<string, unknown>, {
      amount: 4,
      nested: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
      valueOf: 'literal',
    });
    const data = Object.assign(Object.create(null) as Record<string, unknown>, {
      nested: [Object.assign(Object.create(null) as Record<string, unknown>, { accepted: true })],
      valueOf: 'result',
      amount: 4,
    });
    // Deliberately preserve the null prototype to exercise strict JSON normalization.
    const handler = vi.fn(async () => data as never);
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler })],
    });

    const result = await executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { selection },
      context: { surface: 'cli' },
    });

    expect(result).toEqual({ matched: true, result: { ok: true, result: data } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects accessor-backed enum input with a coded result without invoking the accessor', async () => {
    const baseAction = createAction('/unused/daemon.mjs', 'accessor-json');
    const action: ResolvedActionContribution = {
      ...baseAction,
      definition: {
        ...baseAction.definition,
        inputSchema: {
          type: 'object',
          required: ['selection'],
          properties: { selection: { enum: [{ valueOf: 'literal', enabled: true }] } },
          additionalProperties: false,
        },
      },
    };
    let accessorReads = 0;
    const selection = { enabled: true } as Record<string, unknown>;
    Object.defineProperty(selection, 'valueOf', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('accessor must not execute');
      },
    });
    const handler = vi.fn(async () => null);
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler })],
    });

    const result = await executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { selection },
      context: { surface: 'cli' },
    });

    expect(result).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_input_schema_invalid',
        error: 'Plugin action input does not match its manifest inputSchema',
      },
    });
    expect(accessorReads).toBe(0);
    expect(handler).not.toHaveBeenCalled();
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

  it('does not activate plugin runtime while checking built-in action ids', async () => {
    const result = await executePluginActionIfAvailable({
      actionId: 'session.list',
      input: { limit: 2 },
      context: {
        surface: 'cli',
      },
    });

    expect(result).toEqual({ matched: false });
  });

  it('does not synthesize a process-local runtime for external action ids', async () => {
    const result = await executePluginActionIfAvailable({
      actionId: 'acme.review.start',
      input: {},
      context: {
        surface: 'cli',
      },
    });

    expect(result).toEqual({ matched: false });
  });
});
