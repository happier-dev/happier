const { activeRuntimeRegistryState } = vi.hoisted(() => ({
  activeRuntimeRegistryState: {
    registry: null as ResolvedContributionRegistry | null,
    catalogPolicyOutcome: 'visible' as 'visible' | 'denied',
    current: true,
  },
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: () => ({
      generation: 1,
      activeRegistry: activeRuntimeRegistryState.registry
        ? {
            contributes: activeRuntimeRegistryState.registry,
            targetActionInvocations: {
              evaluateCatalogPolicy: () => ({
                outcome: activeRuntimeRegistryState.catalogPolicyOutcome,
                code: activeRuntimeRegistryState.catalogPolicyOutcome === 'visible'
                  ? 'plugin_action_available'
                  : 'plugin_action_generation_retired',
                requiresCurrentIntent: false,
              }),
            },
          }
        : null,
      lastResult: null,
    }),
    isRuntimeRegistryCurrent: () => activeRuntimeRegistryState.current,
  },
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

const env = process.env;

function createRegistryWithPluginTool(params?: Readonly<{
  toolName?: string | null;
  trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
  /** Bundled first-party plugins contribute under `first_party` provenance. */
  provenance?: 'external' | 'first_party';
}>): ResolvedContributionRegistry {
  const provenance = params?.provenance ?? 'external';
  return createResolvedContributionRegistry({
    agents: [],
        actions: [
      {
        provenance,
        source: { kind: 'path' },
        pluginId: 'acme.review.plugin',
        manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
        daemonEntryPath: '/plugins/acme/review/daemon.mjs',
        sourceSpec: {
          kind: 'path',
          locator: '/plugins/acme/review',
          trustPolicy: params?.trustPolicy ?? 'local_trusted',
          installPolicy: 'link',
        },
        definition: {
          kindVersion: 1,
          id: 'review-start',
          title: 'Acme Review Start',
          description: 'Start a plugin-defined review workflow',
          safety: 'safe',
          dangerLevel: 'safe',
          placements: [],
          slash: null,
          bindings: null,
          examples: null,
          surfaces: {
            ui: false,
            voice: false,
            agent: true,
            mcp: true,
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
          execution: {
            routing: 'plugin',
            handler: {
              target: 'plugin',
              exportName: 'startReview',
            },
          },
        },
      },
    ],
    tools: params?.toolName === null
      ? []
      : [{
          provenance,
          source: { kind: 'path' },
          pluginId: 'acme.review.plugin',
          manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
          daemonEntryPath: '/plugins/acme/review/daemon.mjs',
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme/review',
            trustPolicy: params?.trustPolicy ?? 'local_trusted',
            installPolicy: 'link',
          },
          definition: {
            kindVersion: 1,
            id: 'review-tool',
            name: params?.toolName ?? 'acme_review_start',
            title: 'Acme Review Start',
            description: 'Start a plugin-defined review workflow',
            safety: 'safe',
            surfaces: ['agent', 'mcp', 'cli'],
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: true,
            },
            action: 'review-start',
            actionId: 'acme.review.plugin/review-start',
          },
        }],
  });
}

function useActiveRegistryWithPluginTool(
  params?: Parameters<typeof createRegistryWithPluginTool>[0],
  catalogPolicyOutcome: 'visible' | 'denied' = 'visible',
): ResolvedContributionRegistry {
  const registry = createRegistryWithPluginTool(params);
  activeRuntimeRegistryState.registry = registry;
  activeRuntimeRegistryState.catalogPolicyOutcome = catalogPolicyOutcome;
  return registry;
}

describe('listBuiltInHappierTools', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    activeRuntimeRegistryState.registry = null;
    activeRuntimeRegistryState.catalogPolicyOutcome = 'visible';
    activeRuntimeRegistryState.current = true;
  });

  it('filters action-backed tools dynamically using current CLI action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
        'session.title.set': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
      },
    });

    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name);

    expect(names).not.toContain('review_start');
    expect(names).not.toContain('change_title');
    expect(names).toContain('subagents_plan_start');
  });

  it('does not expose MCP-only discovery tools on the CLI surface', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name);

    expect(names).not.toContain('action_spec_search');
    expect(names).not.toContain('action_spec_get');
    expect(names).not.toContain('action_options_resolve');
    expect(names).toContain('action_execute');
    expect(names).toContain('review_start');
  });

  it('applies explicit action settings to manual direct tool equivalents without a separate predicate', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.title.set': {
          disabledSurfaces: ['agent'],
        },
      },
    });

    const names = listBuiltInHappierTools({
      surface: 'agent',
      actionsSettings,
    }).map((tool) => tool.name);

    expect(names).not.toContain('change_title');
  });

  it('does not expose change_title when session title updates are discoverable-only', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.title.set': {
          toolExposureModes: { agent: 'discoverable_only' },
        },
      },
    });

    const names = listBuiltInHappierTools({
      surface: 'agent',
      actionsSettings,
    }).map((tool) => tool.name);

    expect(names).not.toContain('change_title');
  });

  it('promotes required guidance actions unless the user explicitly keeps them discoverable-only', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');

    expect(listBuiltInHappierTools({
      surface: 'agent',
      requiredDirectActionIds: ['memory.search', 'memory.get_window'],
    }).map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'memory_search',
      'memory_get_window',
    ]));

    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'memory.search': {
          toolExposureModes: { agent: 'discoverable_only' },
        },
      },
    });
    const names = listBuiltInHappierTools({
      surface: 'agent',
      actionsSettings,
      requiredDirectActionIds: ['memory.search', 'memory.get_window'],
    }).map((tool) => tool.name);

    expect(names).not.toContain('memory_search');
    expect(names).toContain('memory_get_window');
  });

  it('normalizes first-party and trusted plugin action availability into one result shape', async () => {
    const { resolveActionToolCatalogAvailability } = await import('./actionToolCatalog');
    const registry = useActiveRegistryWithPluginTool();

    expect(resolveActionToolCatalogAvailability({
      actionId: 'session.spawn_new',
      surface: 'agent',
      registry,
    })).toEqual(expect.objectContaining({
      available: true,
      reason: 'available',
      provenance: 'first_party',
      defaultToolExposureMode: 'discoverable_only',
      effectiveToolExposureMode: 'discoverable_only',
    }));

    expect(resolveActionToolCatalogAvailability({
      actionId: 'acme.review.plugin/review-start',
      surface: 'agent',
      registry,
    })).toEqual(expect.objectContaining({
      available: true,
      reason: 'available',
      provenance: 'external',
    }));

    expect(resolveActionToolCatalogAvailability({
      actionId: 'acme.review.plugin/review-start',
      surface: 'agent',
      registry: useActiveRegistryWithPluginTool({ trustPolicy: 'prompt' }, 'denied'),
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'unknown_action',
      provenance: 'external',
    }));
    expect(resolveActionToolCatalogAvailability({
      actionId: 'review-start',
      surface: 'agent',
      registry,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'unknown_action',
      provenance: 'unknown',
    }));
  });

  it('resolves an unbound plugin Action for a bundled first-party plugin on the same terms as an external one', async () => {
    const { resolveActionToolCatalogAvailability } = await import('./actionToolCatalog');
    // Bundled first-party plugins contribute under `first_party` provenance.
    // Both registries below differ only in that field: the catalog policy owner
    // is the one that decides visibility, so provenance must not change the
    // answer for an Action with no declared tool binding.
    expect(resolveActionToolCatalogAvailability({
      actionId: 'acme.review.plugin/review-start',
      surface: 'agent',
      registry: useActiveRegistryWithPluginTool({ toolName: null, provenance: 'external' }),
    })).toEqual(expect.objectContaining({
      available: true,
      reason: 'available',
      provenance: 'external',
    }));

    expect(resolveActionToolCatalogAvailability({
      actionId: 'acme.review.plugin/review-start',
      surface: 'agent',
      registry: useActiveRegistryWithPluginTool({ toolName: null, provenance: 'first_party' }),
    })).toEqual(expect.objectContaining({
      available: true,
      reason: 'available',
      provenance: 'first_party',
    }));
  });

  it('does not let an explicit per-turn plugin tool catalog fall back to the current external registry', async () => {
    const { resolveActionToolCatalogAvailability } = await import('./actionToolCatalog');
    const registry = useActiveRegistryWithPluginTool();

    expect(resolveActionToolCatalogAvailability({
      actionId: 'acme.review.plugin/review-start',
      surface: 'agent',
      registry,
      // The caller supplied an admitted turn catalog. An omitted external
      // Action must not bypass composition by rereading the current registry.
      pluginToolCatalog: [],
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'unknown_action',
      provenance: 'unknown',
    }));
  });

  it('does not expose plugin actions from a registry whose generation is no longer current', async () => {
    const { resolveActionToolCatalogAvailability } = await import('./actionToolCatalog');
    const registry = useActiveRegistryWithPluginTool();
    activeRuntimeRegistryState.current = false;

    expect(resolveActionToolCatalogAvailability({
      actionId: 'acme.review.plugin/review-start',
      surface: 'agent',
      registry,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'unknown_action',
      provenance: 'external',
    }));
  });

  it('keeps session-agent first-party tools discovery-first by default while preserving trusted plugin direct tools', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({
      surface: 'agent',
      registry: useActiveRegistryWithPluginTool(),
    }).map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'action_spec_search',
      'action_spec_get',
      'action_options_resolve',
      'action_execute',
      'change_title',
      'acme_review_start',
    ]));
    expect(names).not.toContain('review_start');
    expect(names).not.toContain('subagents_plan_start');
    expect(names).not.toContain('subagents_delegate_start');
    expect(names).not.toContain('execution_run_start');
  });

  it('lets settings make an external MCP first-party action discoverable-only without hiding plugin tools', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'execution.run.start': {
          toolExposureModes: {
            mcp: 'discoverable_only',
          },
        },
      },
    });
    const names = listBuiltInHappierTools({
      surface: 'mcp',
      registry: useActiveRegistryWithPluginTool(),
      actionsSettings,
    }).map((tool) => tool.name);

    expect(names).not.toContain('execution_run_start');
    expect(names).toContain('subagents_delegate_start');
    expect(names).toContain('acme_review_start');
  });

  it('lists trusted plugin action tools when they explicitly opt into tool exposure', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({
      surface: 'cli',
      registry: useActiveRegistryWithPluginTool(),
    }).map((tool) => tool.name);

    expect(names).toContain('acme_review_start');
  });

  it('fails closed for plugin actions without an explicit tool declaration or runtime policy approval', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');

    const withoutBinding = listBuiltInHappierTools({
      surface: 'cli',
      registry: useActiveRegistryWithPluginTool({ toolName: null }),
    }).map((tool) => tool.name);
    const promptTrusted = listBuiltInHappierTools({
      surface: 'cli',
      registry: useActiveRegistryWithPluginTool({ trustPolicy: 'prompt' }, 'denied'),
    }).map((tool) => tool.name);

    expect(withoutBinding).not.toContain('acme_review_start');
    expect(promptTrusted).not.toContain('acme_review_start');
  });

  it('prefers active authoritative runtime registry tools when available', async () => {
    activeRuntimeRegistryState.registry = createRegistryWithPluginTool({
      toolName: 'acme_runtime_tool',
    });

    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({
      surface: 'cli',
    }).map((tool) => tool.name);

    expect(names).toContain('acme_runtime_tool');
  });

  it('retires plugin tool presentations when the authoritative runtime registry removes their generation', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    activeRuntimeRegistryState.registry = createRegistryWithPluginTool({
      toolName: 'acme_retired_tool',
    });
    expect(listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name))
      .toContain('acme_retired_tool');

    activeRuntimeRegistryState.registry = createResolvedContributionRegistry({
      agents: [],
            actions: [],
      tools: [],
    });
    expect(listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name))
      .not.toContain('acme_retired_tool');
  });

  it('uses the active runtime policy outcome instead of the discovery trust string', async () => {
    activeRuntimeRegistryState.registry = createRegistryWithPluginTool({
      toolName: 'acme_committed_prompt',
      trustPolicy: 'prompt',
    });
    activeRuntimeRegistryState.catalogPolicyOutcome = 'visible';

    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    expect(listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name))
      .toContain('acme_committed_prompt');

    activeRuntimeRegistryState.registry = createRegistryWithPluginTool({
      toolName: 'acme_uncommitted_local',
      trustPolicy: 'local_trusted',
    });
    activeRuntimeRegistryState.catalogPolicyOutcome = 'denied';
    expect(listBuiltInHappierTools({ surface: 'cli' }).map((tool) => tool.name))
      .not.toContain('acme_uncommitted_local');
  });
});
