import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';
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
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createTargetActionInvocationRegistry as createTargetActionInvocationRegistryBase } from '@/plugins/runtime/invocation/targetActionRegistry';
import type { TargetActionInvocationRegistration } from '@/plugins/runtime/invocation/targetActionRegistry';
import type { TargetActionCurrentIntentRequest } from '@/plugins/runtime/invocation/actionExecutor';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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
        api: false,
        plugin: false,
      },
      inputHints: null,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      scopes: ['global'],
      contributionSurfaces: ['cli', 'agent'],
      placementBindings: ['commandPalette'],
      dangerLevel: 'safe',
      execution: {
        target: 'daemon',
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
  resolveCurrentPluginExecutionOrigin?: ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginExecutionOrigin'];
  resolveCurrentPluginImmutableGenerationId?: (pluginId: string) => Promise<string | null>;
  activateContributionsOnDemand: ResolvedExecutablePluginRuntimeRegistry['activateContributionsOnDemand'];
}>): ResolvedExecutablePluginRuntimeRegistry & Readonly<{
  resolveCurrentPluginImmutableGenerationId?: (pluginId: string) => Promise<string | null>;
}> {
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
    ...(params.resolveCurrentPluginExecutionOrigin
      ? { resolveCurrentPluginExecutionOrigin: params.resolveCurrentPluginExecutionOrigin }
      : {}),
    ...(params.resolveCurrentPluginImmutableGenerationId
      ? { resolveCurrentPluginImmutableGenerationId: params.resolveCurrentPluginImmutableGenerationId }
      : {}),
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    resolvePromptAssetBlocks: async () => [],
    retireConsumers: () => {},
    dispose: async () => {},
  };
}

describe('executePluginActionIfAvailable', () => {
  it('fails closed before activation for disabled external and bundled contributed Actions', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.action.plugin/actions/disabled-action': { enabled: false },
      },
    });

    try {
      for (const provenance of ['external', 'first_party'] as const) {
        const source = createAction('/unused/disabled-action.mjs', 'disabled-action');
        const action: ResolvedActionContribution = { ...source, provenance };
        const targetActionInvocations = createTargetActionInvocationRegistry({
          actions: [],
          expectedActions: [{ pluginId: 'acme.action.plugin', localId: 'disabled-action' }],
        });
        const activateContributionsOnDemand = vi.fn(async () => []);

        await expect(executePluginActionIfAvailable({
          runtimeRegistry: createExecutableRegistry({
            action,
            targetActionInvocations,
            activateContributionsOnDemand,
          }),
          actionId: action.definition.id,
          input: {},
          context: { surface: 'cli' },
        })).resolves.toEqual({
          matched: true,
          result: {
            ok: false,
            errorCode: 'plugin_action_unavailable',
            error: 'Plugin action is disabled by Action settings',
            actionHandlerInvocation: 'notStarted',
          },
        });

        expect(activateContributionsOnDemand).not.toHaveBeenCalled();
      }
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('enforces live API settings for a qualified contributed Action ahead of inherited environment settings', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {} });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'acme.action.plugin/actions/live-api-disabled': { disabledSurfaces: ['api'] },
          },
        },
      }),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'account:contributed-action-live-policy',
    });

    try {
      const source = createAction('/unused/live-api-disabled.mjs', 'live-api-disabled');
      const action: ResolvedActionContribution = {
        ...source,
        definition: {
          ...source.definition,
          surfaces: {
            ...source.definition.surfaces,
            cli: false,
            api: true,
            plugin: true,
          },
          contributionSurfaces: ['api', 'plugin'],
        },
      };
      const handler = vi.fn(async () => ({ executed: true }));
      const targetActionInvocations = createTargetActionInvocationRegistry({
        actions: [createTargetActionRegistration({ action, handler })],
        expectedActions: [{ pluginId: 'acme.action.plugin', localId: 'live-api-disabled' }],
      });
      const activateContributionsOnDemand = vi.fn(async () => []);

      await expect(executePluginActionIfAvailable({
        runtimeRegistry: createExecutableRegistry({
          action,
          targetActionInvocations,
          activateContributionsOnDemand,
        }),
        actionId: action.definition.id,
        input: {},
        context: { surface: 'api', invocationSurface: 'api' },
      })).resolves.toEqual({
        matched: true,
        result: {
          ok: false,
          errorCode: 'plugin_action_unavailable',
          error: 'Plugin action is disabled by Action settings',
          actionHandlerInvocation: 'notStarted',
        },
      });

      expect(activateContributionsOnDemand).not.toHaveBeenCalled();
      await expect(executePluginActionIfAvailable({
        runtimeRegistry: createExecutableRegistry({
          action,
          targetActionInvocations,
          activateContributionsOnDemand,
        }),
        actionId: action.definition.id,
        input: {},
        context: {
          surface: 'api',
          invocationSurface: 'api',
          caller: {
            kind: 'plugin',
            pluginId: 'acme.mounted',
            contribution: {
              id: 'dashboard',
              qualifiedId: 'acme.mounted/dashboard',
            },
            materialization: {
              machineId: 'machine-1',
              materializationId: 'materialization-mounted-current',
              pluginId: 'acme.mounted',
            },
            originSurface: 'api',
          },
        },
      })).resolves.toEqual({
        matched: true,
        result: { ok: true, result: { executed: true } },
      });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('applies Off, Ask first, and Allowed settings to one running contributed Action', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    // A stale startup env projection must not win over later Account revisions.
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {} });
    const publishActionsSettings = (actionsSettingsV1: unknown, settingsVersion: number): void => {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ actionsSettingsV1 }),
        settingsVersion,
        loadedAtMs: settingsVersion,
        settingsSecretsReadKeys: [],
        scopeKey: 'account:contributed-action-currentness',
      });
    };

    try {
      const source = createAction('/unused/live-plugin-currentness.mjs', 'live-plugin-currentness');
      const action: ResolvedActionContribution = {
        ...source,
        definition: {
          ...source.definition,
          surfaces: {
            ...source.definition.surfaces,
            agent: false,
            cli: false,
            plugin: true,
          },
          contributionSurfaces: ['plugin'],
        },
      };
      const handler = vi.fn(async () => ({ executed: true }));
      const targetActionInvocations = createTargetActionInvocationRegistry({
        actions: [createTargetActionRegistration({ action, handler })],
      });
      const runtimeRegistry = createExecutableRegistry({
        action,
        targetActionInvocations,
        activateContributionsOnDemand: async () => [],
      });
      const invoke = async (requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<
        Readonly<{ status: 'approved'; fingerprint: string } | { status: 'rejected' | 'unavailable'; code: string }>
      >) => await executePluginActionIfAvailable({
        runtimeRegistry,
        actionId: action.definition.id,
        input: {},
        ...(requestCurrentIntent ? { requestCurrentIntent } : {}),
        context: {
          surface: 'plugin',
          invocationSurface: 'plugin',
          caller: {
            kind: 'plugin',
            pluginId: 'acme.caller',
            contribution: { id: 'dispatcher', qualifiedId: 'acme.caller/actions/dispatcher' },
            materialization: {
              pluginId: 'acme.caller',
              machineId: 'machine-1',
              materializationId: 'materialization-caller-current',
            },
          },
        },
      });

      publishActionsSettings({
        v: 1,
        actions: {
          'acme.action.plugin/actions/live-plugin-currentness': { disabledSurfaces: ['plugin'] },
        },
      }, 1);
      await expect(invoke()).resolves.toEqual({
        matched: true,
        result: {
          ok: false,
          errorCode: 'plugin_action_unavailable',
          error: 'Plugin action is disabled by Action settings',
          actionHandlerInvocation: 'notStarted',
        },
      });
      expect(handler).not.toHaveBeenCalled();

      publishActionsSettings({
        v: 1,
        actions: {
          'acme.action.plugin/actions/live-plugin-currentness': { approvalRequiredSurfaces: ['plugin'] },
        },
      }, 2);
      const requestCurrentIntent = vi.fn(async () => ({
        status: 'rejected' as const,
        code: 'plugin_action_current_intent_rejected',
      }));
      await expect(invoke(requestCurrentIntent)).resolves.toMatchObject({
        matched: true,
        result: {
          ok: false,
          errorCode: 'plugin_action_current_intent_rejected',
          actionHandlerInvocation: 'notStarted',
        },
      });
      expect(requestCurrentIntent).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();

      publishActionsSettings({ v: 1, actions: {} }, 3);
      await expect(invoke()).resolves.toEqual({
        matched: true,
        result: { ok: true, result: { executed: true } },
      });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('requires current intent for a safe contributed Action when Action settings require approval', async () => {
    const previousSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'acme.action.plugin/actions/settings-approval': { approvalRequiredSurfaces: ['cli'] },
      },
    });

    try {
      const action = createAction('/unused/settings-approval.mjs', 'settings-approval');
      const handler = vi.fn(async () => ({ executed: true }));
      const targetActionInvocations = createTargetActionInvocationRegistry({
        actions: [createTargetActionRegistration({ action, handler })],
      });
      let approve: ((value: Readonly<{ status: 'approved'; fingerprint: string }>) => void) | undefined;
      const requestCurrentIntent = vi.fn(async (request: TargetActionCurrentIntentRequest) => await new Promise<Readonly<{
        status: 'approved'; fingerprint: string;
      }>>((resolve) => {
        approve = (value) => resolve(value);
      }));

      const invocation = executePluginActionIfAvailable({
        runtimeRegistry: createExecutableRegistry({
          action,
          targetActionInvocations,
          activateContributionsOnDemand: async () => [],
        }),
        actionId: action.definition.id,
        input: {},
        requestCurrentIntent,
        context: { surface: 'cli' },
      });

      await vi.waitFor(() => expect(requestCurrentIntent).toHaveBeenCalledOnce());
      expect(handler).not.toHaveBeenCalled();
      const request = requestCurrentIntent.mock.calls[0]?.[0];
      if (!request || !approve) throw new Error('Expected Action settings approval request');
      approve({ status: 'approved', fingerprint: request.fingerprint });

      await expect(invocation).resolves.toEqual({
        matched: true,
        result: { ok: true, result: { executed: true } },
      });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      if (previousSettings === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousSettings;
    }
  });

  it('does not daemon-dispatch a client-target contributed Action', async () => {
    const base = createAction('/unused/client-action.mjs', 'open-client');
    const action: SafeResolvedActionContribution = {
      ...base,
      definition: {
        ...base.definition,
        surfaces: {
          ...base.definition.surfaces,
          ui: true,
          cli: false,
          agent: false,
        },
        contributionSurfaces: ['ui'],
        execution: {
          target: 'client',
          client: {
            artifactId: 'client-actions',
            modulePath: './client-actions.js',
            exportName: 'activate',
          },
          platforms: ['web'],
        },
      },
    };
    const daemonHandler = vi.fn(async () => ({ handledBy: 'daemon' }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: daemonHandler })],
    });

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { destination: 'preview' },
      context: { surface: 'ui' },
    })).resolves.toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_client_target_unavailable',
        error: 'Client-target actions must execute on the invoking UI client',
        actionHandlerInvocation: 'notStarted',
      },
    });

    expect(daemonHandler).not.toHaveBeenCalled();
  });

  it('composes public Actions through demand activation with immediate caller attribution', async () => {
    const alphaSource = createAction('/unused/alpha.mjs', 'start');
    const betaSource = createAction('/unused/beta.mjs', 'continue');
    const gammaSource = createAction('/unused/gamma.mjs', 'finish');
    const alpha: ResolvedActionContribution = {
      ...alphaSource,
      pluginId: 'acme.alpha',
      definition: {
        ...alphaSource.definition,
        surfaces: {
          ...alphaSource.definition.surfaces,
          plugin: false,
        },
        contributionSurfaces: ['cli'],
      },
    };
    const beta: ResolvedActionContribution = {
      ...betaSource,
      pluginId: 'acme.beta',
      definition: {
        ...betaSource.definition,
        surfaces: {
          ...betaSource.definition.surfaces,
          agent: false,
          cli: false,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    const gamma: ResolvedActionContribution = {
      ...gammaSource,
      pluginId: 'acme.gamma',
      definition: {
        ...gammaSource.definition,
        surfaces: {
          ...gammaSource.definition.surfaces,
          agent: false,
          cli: false,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    const alphaMaterialization = createPluginActionCallerMaterializationFixture('acme.alpha').materialization;
    const betaMaterialization = createPluginActionCallerMaterializationFixture('acme.beta').materialization;
    const gammaMaterialization = createPluginActionCallerMaterializationFixture('acme.gamma').materialization;
    const materializations = new Map([
      ['acme.alpha', alphaMaterialization],
      ['acme.beta', betaMaterialization],
      ['acme.gamma', gammaMaterialization],
    ]);
    let runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
    const serviceOwners = createProductionPluginInvocationServiceOwners({
      loggerSink: { write: () => {} },
      actionExecutor: { execute: vi.fn() },
      resolveCurrentPluginMaterializationRef: (pluginId) => materializations.get(pluginId) ?? null,
      invokeContributedAction: async (request) => {
        if (!runtimeRegistry) {
          return {
            status: 'unavailable' as const,
            code: 'plugin_action_registry_unavailable',
            message: 'Plugin action registry is not yet committed',
          };
        }
        const attempt = await executePluginActionIfAvailable({
          runtimeRegistry,
          actionId: `${request.action.pluginId}/${request.action.localId}`,
          input: request.input,
          context: {
            surface: request.surface,
            ...(request.originSurface ? { originSurface: request.originSurface } : {}),
            caller: request.caller,
            ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}),
            signal: request.signal,
          },
        });
        if (!attempt.matched) {
          return {
            status: 'unavailable' as const,
            code: 'plugin_action_handler_missing',
            message: 'No declared contributed action matches the exact plugin reference',
          };
        }
        if (attempt.result.ok) {
          return { status: 'executed' as const, value: attempt.result.result };
        }
        return {
          status: 'failed' as const,
          code: attempt.result.errorCode,
          message: attempt.result.error,
        };
      },
    });
    let betaInvocation: Readonly<{ surface: string; caller: unknown }> | null = null;
    let gammaInvocation: Readonly<{ surface: string; caller: unknown }> | null = null;
    const alphaHandler = vi.fn(async (_input, context) => {
      await context.services.actions.execute(
        { pluginId: 'acme.beta', localId: 'continue' },
        { source: 'alpha' },
      );
      return { started: true };
    });
    const betaHandler = vi.fn(async (_input, context) => {
      betaInvocation = Object.freeze({ surface: context.surface, caller: context.caller });
      await context.services.actions.execute(
        { pluginId: 'acme.gamma', localId: 'finish' },
        { source: 'beta' },
      );
      return { continued: true };
    });
    const gammaHandler = vi.fn(async (_input, context) => {
      gammaInvocation = Object.freeze({ surface: context.surface, caller: context.caller });
      return { finished: true };
    });
    const registrations: TargetActionInvocationRegistration[] = [
      createTargetActionRegistration({ action: alpha, handler: alphaHandler }),
    ];
    const targetActionInvocations = createTargetActionInvocationRegistryBase({
      actions: registrations,
      expectedActions: [
        { pluginId: 'acme.alpha', localId: 'start' },
        { pluginId: 'acme.beta', localId: 'continue' },
        { pluginId: 'acme.gamma', localId: 'finish' },
      ],
      readActions: () => registrations,
      resolveAuthorizationFacts: (action) => ({
        generation: {
          targetGeneration: action.generation,
          desiredGeneration: action.generation,
          appliedGeneration: action.generation,
        },
        resourceSelections: [],
        scopedGrants: [],
        operatingSystemAuthorization: [],
      }),
      resolveHostBinding: serviceOwners.resolveHostBinding,
      createServices: serviceOwners.createServices,
      resolveCurrentPluginMaterializationRef: (pluginId) => materializations.get(pluginId) ?? null,
    });
    const activateContributionsOnDemand = vi.fn(async (requests) => {
      for (const request of requests) {
        if (request.pluginId === 'acme.beta' && request.localId === 'continue'
          && !registrations.some((registration) => registration.pluginId === request.pluginId && registration.localId === request.localId)) {
          registrations.push(createTargetActionRegistration({ action: beta, handler: betaHandler }));
        }
        if (request.pluginId === 'acme.gamma' && request.localId === 'finish'
          && !registrations.some((registration) => registration.pluginId === request.pluginId && registration.localId === request.localId)) {
          registrations.push(createTargetActionRegistration({ action: gamma, handler: gammaHandler }));
        }
      }
      targetActionInvocations.refresh();
      return [];
    });
    const baseRegistry = createExecutableRegistry({
      action: alpha,
      targetActionInvocations,
      activateContributionsOnDemand,
    });
    const activeRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
      ...baseRegistry,
      contributes: {
        ...baseRegistry.contributes,
        actions: [alpha, beta, gamma],
        actionsById: new Map([
          ['acme.alpha/start', alpha],
          ['acme.beta/continue', beta],
          ['acme.gamma/finish', gamma],
        ]),
      },
    };
    runtimeRegistry = activeRuntimeRegistry;

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: activeRuntimeRegistry,
      actionId: 'acme.alpha/start',
      input: {},
      context: { surface: 'cli' },
    })).resolves.toEqual({
      matched: true,
      result: { ok: true, result: { started: true } },
    });

    expect(betaInvocation).toEqual({
      surface: 'plugin',
      caller: {
        kind: 'plugin',
        pluginId: 'acme.alpha',
        contribution: { id: 'start', qualifiedId: 'acme.alpha/actions/start' },
        materialization: alphaMaterialization,
        originSurface: 'cli',
      },
    });
    expect(gammaInvocation).toEqual({
      surface: 'plugin',
      caller: {
        kind: 'plugin',
        pluginId: 'acme.beta',
        contribution: { id: 'continue', qualifiedId: 'acme.beta/actions/continue' },
        materialization: betaMaterialization,
        originSurface: 'cli',
      },
    });
    expect(gammaMaterialization.pluginId).toBe('acme.gamma');
    expect(alphaHandler).toHaveBeenCalledOnce();
    expect(betaHandler).toHaveBeenCalledOnce();
    expect(gammaHandler).toHaveBeenCalledOnce();
    expect(activateContributionsOnDemand).toHaveBeenNthCalledWith(1, [{
      pluginId: 'acme.beta', family: 'actions', localId: 'continue',
    }]);
    expect(activateContributionsOnDemand).toHaveBeenNthCalledWith(2, [{
      pluginId: 'acme.gamma', family: 'actions', localId: 'finish',
    }]);
    await serviceOwners.dispose();
  });

  it('derives the plugin target surface from host-stamped plugin caller identity', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          ui: false,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    const target = vi.fn(async (_input, context) => ({
      surface: context.surface,
      caller: context.caller,
    }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: target })],
    });

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: {},
      context: {
        surface: 'ui',
        invocationSurface: 'ui',
        caller: {
          kind: 'plugin',
          pluginId: 'acme.mounted',
          contribution: {
            id: 'dashboard',
            qualifiedId: 'acme.mounted/dashboard',
          },
          materialization: {
            machineId: 'machine-1',
            materializationId: 'materialization-mounted-current',
            pluginId: 'acme.mounted',
          },
          originSurface: 'ui',
        },
      },
    })).resolves.toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          surface: 'plugin',
          caller: {
            kind: 'plugin',
            pluginId: 'acme.mounted',
            contribution: {
              id: 'dashboard',
              qualifiedId: 'acme.mounted/dashboard',
            },
            materialization: {
              machineId: 'machine-1',
              materializationId: 'materialization-mounted-current',
              pluginId: 'acme.mounted',
            },
            originSurface: 'ui',
          },
        },
      },
    });
    expect(target).toHaveBeenCalledTimes(1);
  });

  it('returns the target execution origin only after rereading it at settlement', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.target',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    const resolveCurrentPluginExecutionOrigin = vi.fn(async (pluginId: string) => (
      pluginId === 'acme.target'
        ? Object.freeze({
          serverIdentityId: 'srv_action_origin_fixture',
          materializationRef: Object.freeze({
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-current',
          }),
        })
        : null
    ));
    const target = vi.fn(async () => ({ accepted: true }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: target })],
    });
    const signal = new AbortController().signal;

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        resolveCurrentPluginExecutionOrigin,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { title: 'Ready' },
      captureExecutionOrigin: true,
      context: {
        surface: 'plugin',
        signal,
        caller: {
          kind: 'plugin',
          pluginId: 'acme.caller',
          contribution: { id: 'sender', qualifiedId: 'acme.caller/actions/sender' },
          materialization: {
            pluginId: 'acme.caller',
            machineId: 'machine-caller',
            materializationId: 'materialization-caller-current',
          },
        },
      },
    })).resolves.toEqual({
      matched: true,
      result: {
        ok: true,
        result: { accepted: true },
        executionOrigin: {
          serverIdentityId: 'srv_action_origin_fixture',
          materializationRef: {
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-current',
          },
        },
      },
    });
    expect(target).toHaveBeenCalledTimes(1);
    expect(resolveCurrentPluginExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(resolveCurrentPluginExecutionOrigin).toHaveBeenNthCalledWith(1, 'acme.target', signal);
    expect(resolveCurrentPluginExecutionOrigin).toHaveBeenNthCalledWith(2, 'acme.target', signal);
  });

  it('rejects a mismatched expected target origin before the handler without replacement disclosure', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.target',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    const expectedExecutionOrigin = Object.freeze({
      serverIdentityId: 'srv_action_origin_fixture',
      materializationRef: Object.freeze({
        pluginId: 'acme.target',
        machineId: 'machine-target',
        materializationId: 'materialization-target-before',
      }),
    });
    const resolveCurrentPluginExecutionOrigin = vi.fn(async (pluginId: string) => (
      pluginId === 'acme.target'
        ? Object.freeze({
          serverIdentityId: 'srv_action_origin_fixture',
          materializationRef: Object.freeze({
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-current',
          }),
        })
        : null
    ));
    const target = vi.fn(async () => ({ accepted: true }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: target })],
    });

    const attempt = await executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        resolveCurrentPluginExecutionOrigin,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { title: 'Ready' },
      expectedExecutionOrigin,
      context: {
        surface: 'plugin',
        caller: {
          kind: 'plugin',
          pluginId: 'acme.caller',
          contribution: { id: 'sender', qualifiedId: 'acme.caller/actions/sender' },
          materialization: {
            pluginId: 'acme.caller',
            machineId: 'machine-caller',
            materializationId: 'materialization-caller-current',
          },
        },
      },
    });

    expect(attempt).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_execution_origin_mismatch',
        error: 'Expected target execution origin does not match the current target',
        actionHandlerInvocation: 'notStarted',
      },
    });
    expect(target).not.toHaveBeenCalled();
    expect(resolveCurrentPluginExecutionOrigin).toHaveBeenCalledTimes(1);
    if (!attempt.matched) throw new Error('Expected the declared contributed Action to match');
    expect(attempt.result).not.toHaveProperty('executionOrigin');
  });

  it('fails closed before invoking the target when origin capture has no fresh runtime owner', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.target',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    const target = vi.fn(async () => ({ accepted: true }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: target })],
    });

    await expect(executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { title: 'Ready' },
      captureExecutionOrigin: true,
      context: {
        surface: 'plugin',
        caller: {
          kind: 'plugin',
          pluginId: 'acme.caller',
          contribution: { id: 'sender', qualifiedId: 'acme.caller/actions/sender' },
          materialization: {
            pluginId: 'acme.caller',
            machineId: 'machine-caller',
            materializationId: 'materialization-caller-current',
          },
        },
      },
    })).resolves.toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_execution_origin_unavailable',
        error: 'Current target execution origin is unavailable',
        actionHandlerInvocation: 'notStarted',
      },
    });
    expect(target).not.toHaveBeenCalled();
  });

  it('refuses to publish a retired target execution origin after handler settlement', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.target',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    let materializationId = 'materialization-target-before';
    const resolveCurrentPluginExecutionOrigin = vi.fn(async (pluginId: string) => (
      pluginId === 'acme.target'
        ? Object.freeze({
          serverIdentityId: 'srv_action_origin_fixture',
          materializationRef: Object.freeze({
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId,
          }),
        })
        : null
    ));
    const target = vi.fn(async () => {
      materializationId = 'materialization-target-after';
      return { accepted: true };
    });
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: target })],
    });

    const attempt = await executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        resolveCurrentPluginExecutionOrigin,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { title: 'Ready' },
      captureExecutionOrigin: true,
      expectedExecutionOrigin: {
        serverIdentityId: 'srv_action_origin_fixture',
        materializationRef: {
          pluginId: 'acme.target',
          machineId: 'machine-target',
          materializationId: 'materialization-target-before',
        },
      },
      context: {
        surface: 'plugin',
        caller: {
          kind: 'plugin',
          pluginId: 'acme.caller',
          contribution: { id: 'sender', qualifiedId: 'acme.caller/actions/sender' },
          materialization: {
            pluginId: 'acme.caller',
            machineId: 'machine-caller',
            materializationId: 'materialization-caller-current',
          },
        },
      },
    });

    expect(attempt).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_execution_origin_changed',
        error: 'Target execution origin changed while the contributed Action was running',
      },
    });
    // The refusal is post-start: it must never be mistaken for a handler that
    // did not run, because the effect is already known to have happened.
    expect(attempt.matched && attempt.result).not.toHaveProperty('actionHandlerInvocation');
    expect(attempt.matched && attempt.result).not.toHaveProperty('executionOrigin');
    expect(target).toHaveBeenCalledTimes(1);
    expect(resolveCurrentPluginExecutionOrigin).toHaveBeenCalledTimes(2);
  });

  it('refuses the origin-bearing result when the target origin disappears during the handler', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.target',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    let originAvailable = true;
    const resolveCurrentPluginExecutionOrigin = vi.fn(async (pluginId: string) => (
      pluginId === 'acme.target' && originAvailable
        ? Object.freeze({
          serverIdentityId: 'srv_action_origin_fixture',
          materializationRef: Object.freeze({
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-before',
          }),
        })
        : null
    ));
    const target = vi.fn(async () => {
      originAvailable = false;
      return { accepted: true };
    });
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: target })],
    });

    const attempt = await executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        resolveCurrentPluginExecutionOrigin,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { title: 'Ready' },
      captureExecutionOrigin: true,
      context: {
        surface: 'plugin',
        caller: {
          kind: 'plugin',
          pluginId: 'acme.caller',
          contribution: { id: 'sender', qualifiedId: 'acme.caller/actions/sender' },
          materialization: {
            pluginId: 'acme.caller',
            machineId: 'machine-caller',
            materializationId: 'materialization-caller-current',
          },
        },
      },
    });

    expect(attempt).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_execution_origin_unavailable',
        error: 'Current target execution origin is unavailable',
      },
    });
    expect(attempt.matched && attempt.result).not.toHaveProperty('actionHandlerInvocation');
    expect(target).toHaveBeenCalledTimes(1);
    expect(resolveCurrentPluginExecutionOrigin).toHaveBeenCalledTimes(2);
  });

  it('keeps an ordinary contributed action result when the target origin retires during the handler', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.target',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    let originAvailable = true;
    const resolveCurrentPluginExecutionOrigin = vi.fn(async (pluginId: string) => (
      pluginId === 'acme.target' && originAvailable
        ? Object.freeze({
          serverIdentityId: 'srv_action_origin_fixture',
          materializationRef: Object.freeze({
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-before',
          }),
        })
        : null
    ));
    const target = vi.fn(async () => {
      originAvailable = false;
      return { accepted: true };
    });
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: target })],
    });

    const attempt = await executePluginActionIfAvailable({
      runtimeRegistry: createExecutableRegistry({
        action,
        targetActionInvocations,
        resolveCurrentPluginExecutionOrigin,
        activateContributionsOnDemand: async () => [],
      }),
      actionId: action.definition.id,
      input: { title: 'Ready' },
      context: {
        surface: 'plugin',
        caller: {
          kind: 'plugin',
          pluginId: 'acme.caller',
          contribution: { id: 'sender', qualifiedId: 'acme.caller/actions/sender' },
          materialization: {
            pluginId: 'acme.caller',
            machineId: 'machine-caller',
            materializationId: 'materialization-caller-current',
          },
        },
      },
    });

    expect(attempt).toEqual({
      matched: true,
      result: { ok: true, result: { accepted: true } },
    });
    expect(target).toHaveBeenCalledTimes(1);
    expect(resolveCurrentPluginExecutionOrigin).not.toHaveBeenCalled();
  });

  it('rejects a stale admitted contributor generation before cold activation and admits the fresh binding', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const replacementAction: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.contributor',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    const replacementHandler = vi.fn(async () => ({ handledBy: 'replacement' }));
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({
        action: replacementAction,
        handler: replacementHandler,
      })],
    });
    const runtimeRegistry = createExecutableRegistry({
      action: replacementAction,
      targetActionInvocations,
      resolveCurrentPluginImmutableGenerationId: async (pluginId) => (
        pluginId === 'acme.contributor' ? 'generation-b' : null
      ),
      activateContributionsOnDemand: async () => [],
    });

    const staleRequest = {
      runtimeRegistry,
      actionId: replacementAction.definition.id,
      input: { title: 'Ready' },
      expectedContributorImmutableGenerationId: 'generation-a',
      context: {
        surface: 'plugin' as const,
        caller: {
          kind: 'plugin' as const,
          pluginId: 'acme.target',
          contribution: { id: 'providers', qualifiedId: 'acme.target/points/providers' },
          materialization: {
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-current',
          },
        },
      },
    };
    const staleAttempt = await executePluginActionIfAvailable(staleRequest);

    expect(staleAttempt).toEqual({
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_generation_retired',
        error: 'Admitted contributor generation is no longer current',
        actionHandlerInvocation: 'notStarted',
      },
    });
    expect(replacementHandler).not.toHaveBeenCalled();

    const freshRequest = {
      runtimeRegistry,
      actionId: replacementAction.definition.id,
      input: { title: 'Ready' },
      expectedContributorImmutableGenerationId: 'generation-b',
      context: {
        surface: 'plugin' as const,
        caller: {
          kind: 'plugin' as const,
          pluginId: 'acme.target',
          contribution: { id: 'providers', qualifiedId: 'acme.target/points/providers' },
          materialization: {
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-current',
          },
        },
      },
    };
    await expect(executePluginActionIfAvailable(freshRequest)).resolves.toEqual({
      matched: true,
      result: { ok: true, result: { handledBy: 'replacement' } },
    });
    expect(replacementHandler).toHaveBeenCalledOnce();
  });

  it('preserves a known admitted contributor result when its generation retires during the handler', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.contributor',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    let immutableGenerationId = 'generation-a';
    const handler = vi.fn(async () => {
      immutableGenerationId = 'generation-b';
      return { handledBy: 'retired-a' };
    });
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler })],
    });
    const runtimeRegistry = createExecutableRegistry({
      action,
      targetActionInvocations,
      resolveCurrentPluginImmutableGenerationId: async (pluginId) => (
        pluginId === 'acme.contributor' ? immutableGenerationId : null
      ),
      activateContributionsOnDemand: async () => [],
    });

    const request = {
      runtimeRegistry,
      actionId: action.definition.id,
      input: { title: 'Ready' },
      expectedContributorImmutableGenerationId: 'generation-a',
      context: {
        surface: 'plugin' as const,
        caller: {
          kind: 'plugin' as const,
          pluginId: 'acme.target',
          contribution: { id: 'providers', qualifiedId: 'acme.target/points/providers' },
          materialization: {
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-current',
          },
        },
      },
    };
    await expect(executePluginActionIfAvailable(request)).resolves.toEqual({
      matched: true,
      result: {
        ok: true,
        result: { handledBy: 'retired-a' },
      },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('preserves a known admitted contributor result when its real runtime materialization retires', async () => {
    const externalAction = createAction('/unused/daemon.mjs', 'publish');
    const action: ResolvedActionContribution = {
      ...externalAction,
      pluginId: 'acme.contributor',
      definition: {
        ...externalAction.definition,
        surfaces: {
          ...externalAction.definition.surfaces,
          plugin: true,
        },
        contributionSurfaces: ['plugin'],
      },
    };
    let materializationId = 'materialization-a';
    const handler = vi.fn(async () => {
      materializationId = 'materialization-b';
      return { handledBy: 'retired-materialization-a' };
    });
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler })],
    });
    const runtimeRegistry = {
      ...createExecutableRegistry({
        action,
        targetActionInvocations,
        resolveCurrentPluginImmutableGenerationId: async (pluginId) => (
          pluginId === 'acme.contributor' ? 'generation-a' : null
        ),
        activateContributionsOnDemand: async () => [],
      }),
      resolveCurrentPluginMaterializationRef: (pluginId: string) => (
        pluginId === 'acme.contributor'
          ? Object.freeze({
            pluginId,
            machineId: 'machine-contributor',
            materializationId,
          })
          : null
      ),
    };

    const request = {
      runtimeRegistry,
      actionId: action.definition.id,
      input: { title: 'Ready' },
      expectedContributorImmutableGenerationId: 'generation-a',
      expectedContributorMaterializationId: 'materialization-a',
      context: {
        surface: 'plugin' as const,
        caller: {
          kind: 'plugin' as const,
          pluginId: 'acme.target',
          contribution: { id: 'providers', qualifiedId: 'acme.target/points/providers' },
          materialization: {
            pluginId: 'acme.target',
            machineId: 'machine-target',
            materializationId: 'materialization-target-current',
          },
        },
      },
    };

    await expect(executePluginActionIfAvailable(request)).resolves.toEqual({
      matched: true,
      result: {
        ok: true,
        result: { handledBy: 'retired-materialization-a' },
      },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

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

  it('preserves a null result from the committed target action registry', async () => {
    const action = createAction('/unused/daemon.mjs', 'clear');
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: async () => null })],
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
      result: { ok: true, result: null },
    });
  });

  it('normalizes a void target result to schema-validated null through the contributed-action owner', async () => {
    const baseAction = createAction('/unused/daemon.mjs', 'clear-void');
    const action: ResolvedActionContribution = {
      ...baseAction,
      definition: {
        ...baseAction.definition,
        outputSchema: { type: 'null' },
      },
    };
    const target = vi.fn(async () => undefined);
    const targetActionInvocations = createTargetActionInvocationRegistry({
      actions: [createTargetActionRegistration({ action, handler: target })],
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
      result: { ok: true, result: null },
    });
    expect(target).toHaveBeenCalledOnce();
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
        actionHandlerInvocation: 'notStarted',
      },
    });
  });

  it('activates the executable action registration behind a command contribution', async () => {
    const action = createAction('/unused/daemon.mjs', 'start');
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
      localId: 'start',
    }]);
    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          actionId: 'start',
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
    const action = createAction('/unused/daemon.mjs', 'inspect');
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
      localId: 'inspect',
    }]);
    expect(result).toEqual({
      matched: true,
      result: {
        ok: true,
        result: {
          actionId: 'inspect',
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
        actionHandlerInvocation: 'notStarted',
      },
    });
  });

  it('uses the committed target action generation instead of stale sourceSpec trust metadata', async () => {
    const trustedAction = createAction('/unused/daemon.mjs', 'untrusted');
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
        actionHandlerInvocation: 'notStarted',
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
        actionHandlerInvocation: 'notStarted',
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
        actionHandlerInvocation: 'notStarted',
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
