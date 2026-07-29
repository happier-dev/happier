import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { PluginManifest } from '../manifest.js';
import type { PluginInvocationUi } from '../invocation.js';
import type { PluginMcpServerRuntime } from '../activation.js';
import type { AgentRuntimeFactory } from '../agentRuntime/index.js';
import type { PluginServices } from '../services/index.js';
import { createPluginTestkit, type PluginTestkit } from './host.js';
import type { PluginRuntimeRegistration } from './registrationScope.js';

const manifest = {
  schemaVersion: 2,
  id: 'acme.testkit',
  version: '1.0.0',
  displayName: 'Testkit Fixture',
  engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
  contributes: {
    actions: [{
      id: 'echo',
      title: 'Echo',
      scopes: ['global'],
      surfaces: ['cli'],
      placement: 'commandPalette',
      dangerLevel: 'safe',
    }],
  },
} satisfies PluginManifest;

const agentManifest = {
  ...manifest,
  contributes: {
    agents: [{
      id: 'assistant',
      title: 'Assistant',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        surfaces: ['terminal'],
        sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
      },
    }],
  },
} satisfies PluginManifest;

const agentWithExternalSessionsManifest = {
  ...agentManifest,
  contributes: {
    agents: [{
      ...agentManifest.contributes.agents[0],
      capabilities: {
        ...agentManifest.contributes.agents[0].capabilities,
        surfaces: ['terminal', 'externalSessions'],
      },
      surfaces: {
        externalSession: {
          sources: [{
            sourceKind: 'test',
            schema: {
              fields: [{ kind: 'literal', name: 'kind', value: 'test' }],
              passthrough: false,
            },
            key: { segments: [{ kind: 'literal', value: 'test' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
    }],
  },
} satisfies PluginManifest;

const mcpManifest = {
  ...manifest,
  contributes: {
    actions: manifest.contributes.actions,
    mcp: {
      servers: [{ id: 'tools', title: 'Tools', kind: 'dynamic' }],
      discoveryProviders: [],
    },
  },
} satisfies PluginManifest;

function mcpRuntime(dispose: PluginMcpServerRuntime['dispose']): PluginMcpServerRuntime {
  return {
    async listTools() { return { items: [] }; },
    async callTool() { return { content: [] }; },
    dispose,
  };
}

const agentFactory = (async () => ({
  sessions: {
    create: async () => { throw new Error('not invoked'); },
    resume: async () => { throw new Error('not invoked'); },
    fork: async () => { throw new Error('not invoked'); },
    attach: async () => { throw new Error('not invoked'); },
  },
})) as unknown as AgentRuntimeFactory;

type MissingPluginTestkitRegistrationFamily = {
  [TFamily in PluginRuntimeRegistration['family']]:
  PluginTestkit['registration'] extends (
    family: TFamily,
    localId: string,
  ) => Extract<PluginRuntimeRegistration, { family: TFamily }>['value'] | undefined
    ? never
    : TFamily;
}[PluginRuntimeRegistration['family']];

describe('createPluginTestkit', () => {
  it('derives the registration lookup family set from the canonical registration union', () => {
    expectTypeOf<MissingPluginTestkitRegistrationFamily>().toEqualTypeOf<never>();
  });

  it('activates declared registrations and invokes the real registered action without daemon state', async () => {
    const uiCalls: string[] = [];
    const ui = Object.freeze({
      async requestApproval() {
        return { status: 'denied' as const };
      },
      async askQuestions() {
        return { status: 'cancelled' as const };
      },
      async confirm(message: string) {
        uiCalls.push(`confirm:${message}`);
        return true;
      },
      async notify(message: string) {
        uiCalls.push(`notify:${message}`);
      },
      status: Object.freeze({ async set(key: string, text: string | null) { uiCalls.push(`status:${key}:${text}`); } }),
      widget: Object.freeze({ async set() {} }),
      title: Object.freeze({ async set() {} }),
      composer: Object.freeze({ async replace() {} }),
    }) satisfies PluginInvocationUi;
    const services = Object.freeze({
      availability() {
        return Object.freeze({
          status: 'unavailable' as const,
          code: 'fixture_service_unavailable',
        });
      },
    }) as unknown as PluginServices;
    const testkit = await createPluginTestkit({
      manifest,
      ui,
      services,
      module: {
        activate(api) {
          api.actions.register('echo', async (input, context) => ({
            input,
            pluginId: context.plugin.id,
            contributionId: context.contribution.id,
            qualifiedContributionId: context.contribution.qualifiedId,
            serviceAvailability: context.services.availability('storage').status,
            servicesIsFixture: context.services === services,
            confirmed: await context.ui.confirm('Continue?'),
            uiIsFixture: context.ui === ui,
          }));
        },
      },
    });

    await expect(testkit.invokeAction('echo', { value: 42 })).resolves.toEqual({
      input: { value: 42 },
      pluginId: 'acme.testkit',
      contributionId: 'echo',
      qualifiedContributionId: 'acme.testkit/actions/echo',
      serviceAvailability: 'unavailable',
      servicesIsFixture: true,
      confirmed: true,
      uiIsFixture: true,
    });
    expect(uiCalls).toEqual(['confirm:Continue?']);
    expect(testkit.registrations()).toEqual([{ family: 'actions', localId: 'echo' }]);
    expect(testkit).not.toHaveProperty('install');
    expect(testkit).not.toHaveProperty('currentGeneration');

    await testkit.dispose();
    await expect(testkit.invokeAction('echo', null)).rejects.toThrow(/disposed/u);
  });

  it('provides a typed unavailable UI facade when a fixture does not opt in', async () => {
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => {
            await context.ui.notify('Finished');
            return null;
          });
        },
      },
    });

    await expect(testkit.invokeAction('echo', null)).rejects.toMatchObject({
      code: 'plugin_ui_unavailable',
    });
  });

  it('rejects undeclared or missing registrations through canonical manifest rights', async () => {
    await expect(createPluginTestkit({
      manifest,
      module: { activate(api) { api.actions.register('other', () => undefined); } },
    })).rejects.toThrow(/undeclared contribution/u);

    await expect(createPluginTestkit({
      manifest,
      module: { activate() {} },
    })).rejects.toThrow(/missing registration/u);
  });

  it('exposes canonical snapshots while rejecting undeclared, duplicate, and incomplete Agent facets', async () => {
    const testkit = await createPluginTestkit({
      manifest: agentManifest,
      module: {
        activate(api) {
          api.agents.register('assistant', agentFactory);
        },
      },
    });
    const assistantRegistration = testkit.registration('agents', 'assistant');
    expectTypeOf(assistantRegistration).toEqualTypeOf<
      Extract<PluginRuntimeRegistration, { family: 'agents' }>['value'] | undefined
    >();
    expect(assistantRegistration).toEqual({
      factory: agentFactory,
    });
    await testkit.dispose();

    await expect(createPluginTestkit({
      manifest: agentManifest,
      module: {
        activate(api) {
          api.agents.register('other', agentFactory);
        },
      },
    })).rejects.toThrow(/undeclared contribution/u);

    await expect(createPluginTestkit({
      manifest: agentManifest,
      module: {
        activate(api) {
          api.agents.register('assistant', agentFactory);
          api.agents.register('assistant', agentFactory);
        },
      },
    })).rejects.toThrow(/duplicate Agent runtime/u);

    await expect(createPluginTestkit({
      manifest: agentWithExternalSessionsManifest,
      module: {
        activate(api) {
          api.agents.register('assistant', agentFactory);
        },
      },
    })).rejects.toThrow(/missing Agent External Sessions contribution/u);
  });

  it('rejects the same malformed Agent provider bindings as the production registration host', async () => {
    const prepareGetter = vi.fn(() => () => ({ v: 1, materialization: 'spawnEnv' as const }));
    const providerBinding = {
      v: 1,
      adapterVersion: 1,
      materialize: async () => ({ v: 1 as const, kind: 'spawnEnv' as const, env: [] }),
    } as Record<string, unknown>;
    Object.defineProperty(providerBinding, 'prepare', {
      enumerable: true,
      get: prepareGetter,
    });

    await expect(createPluginTestkit({
      manifest: agentManifest,
      module: {
        activate(api) {
          api.agents.register('assistant', agentFactory, {
            providerBinding: providerBinding as never,
          });
        },
      },
    })).rejects.toThrow(/invalid Agent provider binding/u);
    expect(prepareGetter).not.toHaveBeenCalled();
  });

  it('aborts testkit-owned invocation signals when the testkit is disposed', async () => {
    let invocationSignal: AbortSignal | undefined;
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => {
            invocationSignal = context.signal;
            await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
            return null;
          });
        },
      },
    });

    const invocation = testkit.invokeAction('echo', null);
    await Promise.resolve();
    expect(invocationSignal?.aborted).toBe(false);
    await testkit.dispose();
    expect(invocationSignal?.aborted).toBe(true);
    await expect(invocation).rejects.toMatchObject({
      code: 'plugin_action_generation_retired',
    });
  });

  it('runs the activation cleanup once when the testkit is disposed', async () => {
    const cleanup = vi.fn(async () => undefined);
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', () => null);
          return cleanup;
        },
      },
    });

    await testkit.dispose();
    await testkit.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('awaits registered dynamic MCP disposal before activation cleanup', async () => {
    const cleanupOrder: string[] = [];
    const disposeRuntime = vi.fn(async () => { cleanupOrder.push('mcp'); });
    const cleanup = vi.fn(async () => { cleanupOrder.push('activation'); });
    const testkit = await createPluginTestkit({
      manifest: mcpManifest,
      module: {
        activate(api) {
          api.actions.register('echo', () => null);
          api.mcp.registerServer('tools', mcpRuntime(disposeRuntime));
          return cleanup;
        },
      },
    });

    await testkit.dispose();
    await testkit.dispose();

    expect(cleanupOrder).toEqual(['mcp', 'activation']);
    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs the resolved activation cleanup when registration validation fails', async () => {
    const cleanup = vi.fn(async () => undefined);

    await expect(createPluginTestkit({
      manifest,
      module: { activate: () => cleanup },
    })).rejects.toThrow(/missing registration/u);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
