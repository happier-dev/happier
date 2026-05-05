const { activeRuntimeRegistryState } = vi.hoisted(() => ({
  activeRuntimeRegistryState: {
    registry: null as ResolvedContributionRegistry | null,
  },
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: () => ({
      generation: 1,
      activeRegistry: activeRuntimeRegistryState.registry
        ? { contributes: activeRuntimeRegistryState.registry }
        : null,
      lastResult: null,
    }),
  },
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

const env = process.env;

function createRegistryWithPluginTool(params?: Readonly<{
  toolName?: string | null;
  trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
}>): ResolvedContributionRegistry {
  return createResolvedContributionRegistry({
    providers: [],
    backends: [],
    actions: [
      {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: 'acme.review.plugin',
        manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
        manifestDigest: 'sha256:acme-review',
        daemonEntryPath: '/plugins/acme/review/daemon.mjs',
        sourceSpec: {
          kind: 'path',
          locator: '/plugins/acme/review',
          trustPolicy: params?.trustPolicy ?? 'local_trusted',
          installPolicy: 'link',
        },
        definition: {
          kindVersion: 1,
          id: 'acme.review.start',
          title: 'Acme Review Start',
          description: 'Start a plugin-defined review workflow',
          safety: 'safe',
          placements: [],
          slash: null,
          bindings: params?.toolName === null
            ? null
            : { mcpToolName: params?.toolName ?? 'acme_review_start' },
          examples: null,
          surfaces: {
            ui: false,
            voice: false,
            session_agent: true,
            mcp: true,
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
            routing: 'plugin',
            handler: {
              target: 'plugin',
              exportName: 'startReview',
            },
          },
        },
      },
    ],
  });
}

describe('listBuiltInHappierTools', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    activeRuntimeRegistryState.registry = null;
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

  it('lists trusted plugin action tools when they explicitly opt into tool exposure', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');
    const names = listBuiltInHappierTools({
      surface: 'cli',
      registry: createRegistryWithPluginTool(),
    }).map((tool) => tool.name);

    expect(names).toContain('acme_review_start');
  });

  it('fails closed for plugin action tools without explicit bindings or trust approval', async () => {
    const { listBuiltInHappierTools } = await import('./listBuiltInHappierTools');

    const withoutBinding = listBuiltInHappierTools({
      surface: 'cli',
      registry: createRegistryWithPluginTool({ toolName: null }),
    }).map((tool) => tool.name);
    const promptTrusted = listBuiltInHappierTools({
      surface: 'cli',
      registry: createRegistryWithPluginTool({ trustPolicy: 'prompt' }),
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
});
