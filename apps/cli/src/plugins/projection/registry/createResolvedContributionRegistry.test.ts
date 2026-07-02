import { describe, expect, it } from 'vitest';

import {
  AGENT_PROVIDER_IDS,
  AGENT_IDS,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
} from '@happier-dev/agents';

import {
  createResolvedContributionRegistry,
  getResolvedContributionRegistry,
  primeResolvedContributionRegistry,
} from './createResolvedContributionRegistry';
import type { ResolvedHookRegistration } from './types';

describe('getResolvedContributionRegistry', () => {
  it('indexes built-in provider, backend, and catalog entries through one resolved registry', () => {
    const registry = getResolvedContributionRegistry();
    const backendDefinitionIds = getAllBackendDefinitionContracts().map((entry) => entry.id).slice().sort();
    const providerDefinitionIds = getAllProviderDefinitionContracts().map((entry) => entry.id).slice().sort();

    expect(Object.keys(registry.catalogEntriesById).slice().sort()).toEqual([...AGENT_PROVIDER_IDS].slice().sort());
    expect(registry.providers.map((entry) => entry.definition.id).slice().sort()).toEqual(providerDefinitionIds);

    for (const agentId of AGENT_IDS) {
      expect(registry.providerDefinitionsById.get(agentId)?.id).toBe(agentId);
      expect(registry.providerDefinitionsById.get(agentId)?.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: agentId,
        }),
      );
      expect(registry.catalogEntriesById[agentId]?.id).toBe(agentId);
    }

    for (const backendId of backendDefinitionIds) {
      expect(registry.backendDefinitionsById.get(backendId)?.id).toBe(backendId);
      expect(registry.backendDefinitionsById.get(backendId)?.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: backendId,
          providerId: backendId,
        }),
      );
    }

    expect(registry.backendDefinitionsById.get('codex')).not.toHaveProperty('getRuntimeCore');
  });

  it('keeps the built-in snapshot isolated after priming merged contributes', async () => {
    const builtInRegistry = getResolvedContributionRegistry();
    expect(Object.keys(builtInRegistry.catalogEntriesById).slice().sort()).toEqual([...AGENT_PROVIDER_IDS].slice().sort());

    const mergedRegistry = await primeResolvedContributionRegistry({ happyHomeDir: 'prime-isolated-home' });
    expect(mergedRegistry.catalogEntriesById.codex?.id).toBe('codex');

    const builtInAfterPrime = getResolvedContributionRegistry();
    expect(Object.keys(builtInAfterPrime.catalogEntriesById).slice().sort()).toEqual([...AGENT_PROVIDER_IDS].slice().sort());
    expect(builtInAfterPrime.catalogEntriesById['acme.ohmypi']).toBeUndefined();
  });

  it('indexes action contributes in deterministic order on an immutable snapshot', () => {
    const registry = createResolvedContributionRegistry({
      providers: Object.freeze([
        {
          id: 'acme.provider',
          provenance: 'external',
          source: { kind: 'path' },
          definition: {
            kindVersion: 1,
            id: 'acme.provider',
            ownedBackendIds: Object.freeze([]),
          },
        },
      ]),
      backends: Object.freeze([]),
      actions: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          manifestDigest: 'sha256:beta',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'beta.review.start',
            title: 'Beta Review',
            description: null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              session_agent: false,
              mcp: false,
              cli: true,
              rpc: false,
              sdk: false,
            },
            inputHints: null,
            inputSchema: {},
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'alpha.review.start',
            title: 'Alpha Review',
            description: null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              session_agent: false,
              mcp: false,
              cli: true,
              rpc: false,
              sdk: false,
            },
            inputHints: null,
            inputSchema: {},
          },
        },
      ]),
      events: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          manifestDigest: 'sha256:beta',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            id: 'beta.plugin/review/ready',
            localId: 'review/ready',
            payloadSchema: {},
            deprecated: false,
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.plugin/review/ready',
            localId: 'review/ready',
            payloadSchema: {},
            deprecated: false,
          },
        },
      ]),
      requestInterceptors: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          manifestDigest: 'sha256:beta',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            id: 'beta.policy',
            order: 20,
            targets: [{ scope: 'plugin-fetch' }],
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.policy',
            order: 10,
            targets: [{ scope: 'plugin-fetch' }],
          },
        },
      ]),
    });
    const actionIndexedRegistry = registry as typeof registry & Readonly<{
      actionsById: ReadonlyMap<string, unknown>;
      eventsById: ReadonlyMap<string, unknown>;
      generationId: string;
    }>;

    expect(registry.actions.map((action) => action.definition.id)).toEqual([
      'alpha.review.start',
      'beta.review.start',
    ]);
    expect(actionIndexedRegistry.actionsById.get('alpha.review.start')).toMatchObject({
      pluginId: 'alpha.plugin',
    });
    expect(registry.events?.map((event) => event.definition.id)).toEqual([
      'alpha.plugin/review/ready',
      'beta.plugin/review/ready',
    ]);
    expect(actionIndexedRegistry.eventsById.get('alpha.plugin/review/ready')).toMatchObject({
      pluginId: 'alpha.plugin',
    });
    expect(registry.requestInterceptors?.map((interceptor) => interceptor.definition.id)).toEqual([
      'alpha.policy',
      'beta.policy',
    ]);
    expect(actionIndexedRegistry.generationId).toMatch(/^registry:/);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.actions)).toBe(true);
  });

  it('indexes event contributes by canonical plugin-qualified id when local ids match', () => {
    const registry = createResolvedContributionRegistry({
      providers: Object.freeze([]),
      backends: Object.freeze([]),
      events: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'task/complete',
            localId: 'task/complete',
            payloadSchema: {},
            deprecated: false,
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          manifestDigest: 'sha256:beta',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            id: 'task/complete',
            localId: 'task/complete',
            payloadSchema: {},
            deprecated: false,
          },
        },
      ]),
    });

    expect(registry.eventsById?.get('alpha.plugin/task/complete')).toMatchObject({
      pluginId: 'alpha.plugin',
    });
    expect(registry.eventsById?.get('beta.plugin/task/complete')).toMatchObject({
      pluginId: 'beta.plugin',
    });
  });

  it('rejects duplicate event local ids within the same plugin', () => {
    expect(() => createResolvedContributionRegistry({
      providers: Object.freeze([]),
      backends: Object.freeze([]),
      events: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha-one',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.plugin/task/complete',
            localId: 'task/complete',
            payloadSchema: {},
            deprecated: false,
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha-two',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.plugin/task/done',
            localId: 'task/complete',
            payloadSchema: {},
            deprecated: false,
          },
        },
      ]),
    })).toThrow("Duplicate event contribution 'alpha.plugin/task/complete' from plugin 'alpha.plugin'");
  });

  it('rejects duplicate action ids before they can reach host action surfaces', () => {
    expect(() => createResolvedContributionRegistry({
      providers: Object.freeze([]),
      backends: Object.freeze([]),
      actions: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'acme.review.start',
            title: 'Alpha Review',
            description: null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              session_agent: false,
              mcp: false,
              cli: true,
              rpc: false,
              sdk: false,
            },
            inputHints: null,
            inputSchema: {},
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          manifestDigest: 'sha256:beta',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'acme.review.start',
            title: 'Beta Review',
            description: null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              session_agent: false,
              mcp: false,
              cli: true,
              rpc: false,
              sdk: false,
            },
            inputHints: null,
            inputSchema: {},
          },
        },
      ]),
    })).toThrow("Duplicate action contribution 'acme.review.start'");
  });

  it('indexes tool, command, and lifecycle-handler definitions alongside action contributes', () => {
    const registry = createResolvedContributionRegistry({
      providers: Object.freeze([
        {
          id: 'acme.provider',
          provenance: 'external',
          source: { kind: 'path' },
          definition: {
            kindVersion: 1,
            id: 'acme.provider',
            ownedBackendIds: Object.freeze([]),
          },
        },
      ]),
      backends: Object.freeze([]),
      actions: Object.freeze([]),
      tools: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.plugin',
          manifestPath: '/plugins/acme/plugin.json',
          manifestDigest: 'sha256:tool',
          daemonEntryPath: '/plugins/acme/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'acme.tool',
            name: 'acme_tool',
            title: 'Acme Tool',
            description: 'Runs the Acme tool',
            safety: 'safe',
            surfaces: {
              cli: true,
              mcp: true,
              session_agent: false,
            },
            inputSchema: {},
            actionId: 'acme.tool',
          },
        },
      ]),
      commands: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.plugin',
          manifestPath: '/plugins/acme/plugin.json',
          manifestDigest: 'sha256:command',
          daemonEntryPath: '/plugins/acme/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'acme.command',
            command: 'acme-review',
            rootHelpLabel: 'happier acme-review',
            rootHelpDescription: 'Run the Acme review command',
            allowTmux: false,
            actionId: 'acme.command',
          },
        },
      ]),
      lifecycleHandlers: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.plugin',
          manifestPath: '/plugins/acme/plugin.json',
          manifestDigest: 'sha256:lifecycle',
          daemonEntryPath: '/plugins/acme/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'acme.lifecycle.activated',
            event: 'activated',
            priority: 10,
          },
        },
      ]),
    });

    expect(registry.tools?.map((tool) => tool.definition.id)).toEqual(['acme.tool']);
    expect(registry.commands?.map((command) => command.definition.id)).toEqual(['acme.command']);
    expect(registry.lifecycleHandlers?.map((handler) => handler.definition.id)).toEqual(['acme.lifecycle.activated']);
    expect(registry.toolsById?.get('acme.tool')).toMatchObject({
      pluginId: 'acme.plugin',
    });
    expect(registry.commandsById?.get('acme.command')).toMatchObject({
      pluginId: 'acme.plugin',
    });
    expect(registry.lifecycleHandlersById?.get('acme.lifecycle.activated')).toMatchObject({
      pluginId: 'acme.plugin',
    });
    expect(registry.generationId).toContain('tool:external:path:acme.tool:acme_tool:sha256:tool');
    expect(registry.generationId).toContain('command:external:path:acme.command:acme-review:sha256:command');
    expect(registry.generationId).toContain('lifecycle:external:path:acme.lifecycle.activated:activated:sha256:lifecycle');
  });

  it('excludes hook registrations that are not backed by the final hook catalog', () => {
    const validHook: ResolvedHookRegistration = {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'acme.hooks',
      manifestPath: '/plugins/acme/plugin.json',
      manifestDigest: 'sha256:hooks',
      daemonEntryPath: '/plugins/acme/daemon.mjs',
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/acme',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      definition: {
        hookApiVersion: 1,
        id: 'subagent.start',
        category: 'lifecycle',
        scope: 'session',
        executionKind: 'observe',
        handler: {
          target: 'plugin',
          exportName: 'onSubagentStart',
        },
      },
    };
    const staleHook: ResolvedHookRegistration = {
      ...validHook,
      definition: {
        ...validHook.definition,
        id: 'provider.request.before',
      },
    };

    const registry = createResolvedContributionRegistry({
      providers: Object.freeze([]),
      backends: Object.freeze([]),
      actions: Object.freeze([]),
      resources: Object.freeze([]),
      uiDescriptors: Object.freeze([]),
      activationTargets: Object.freeze([]),
      hookRegistrations: Object.freeze([validHook, staleHook]),
    });

    expect(registry.hookRegistrations.map((hook) => hook.definition.id)).toEqual(['subagent.start']);
    expect(registry.pluginDiagnosticsByPluginId['acme.hooks']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
      }),
    ]);
  });
});
