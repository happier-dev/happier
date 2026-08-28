import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_IDS,
  getAllAgentDefinitionContracts,
} from '@happier-dev/agents';

import {
  createResolvedContributionRegistry,
  getResolvedContributionRegistry,
  primeResolvedContributionRegistry,
  resolveMergedContributionRegistry,
} from './createResolvedContributionRegistry';
import {
  PluginContributesV2Schema,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/protocol/automations/event-setup-result';
import {
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/protocol/automations/event-history-gap-reset-action';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { ResolvedActivatedHookRegistration } from './types';

async function writeInstalledSettingsPlugin(params: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  pluginId: string;
  settingsId: string;
}>): Promise<void> {
  await mkdir(join(params.pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(params.pluginRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
  await writeFile(
    join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: params.pluginId,
      displayName: 'Acme Settings Merge',
      description: 'Settings merge fixture',
      contributes: {
        settings: [
          {
            id: params.settingsId,
            title: 'Acme settings',
            target: { kind: 'plugin' },
            scope: 'daemon',
            fields: [
              {
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string' },
              },
            ],
          },
        ],
      },
    }), null, 2),
    'utf8',
  );

  await createPluginStateStore({ happyHomeDir: params.happyHomeDir }).write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [params.pluginId]: {
        source: {
          kind: 'path',
          locator: params.pluginRoot,
          trustPolicy: 'local_trusted',
          installPolicy: 'link',
          resolvedPath: params.pluginRoot,
          manifestPath: join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
        },
        compatibility: {
          status: 'compatible',
          diagnostics: [],
        },
        install: {
          mode: 'link',
          manifestVersion: '1.0.0',
          installedPath: null,
        },
        state: {
          enabled: true,
        },
      },
    },
  });
}

describe('getResolvedContributionRegistry', () => {
  it('does not project the retired static backend surface-handler registry', () => {
    const registry = createResolvedContributionRegistry({});

    expect(registry).not.toHaveProperty('surfaceHandlersByBackendId');
  });

  it('rejects duplicate qualified UI destination and renderer bindings before projection', () => {
    const binding = (id: string) => ({
      pluginId: 'acme.review',
      definition: { id },
    });
    // This registry-boundary fixture supplies only the identity fields this owner
    // reads before any UI activation or projection work begins.
    const inputs = (value: object) => value as Parameters<typeof createResolvedContributionRegistry>[0];

    expect(() => createResolvedContributionRegistry(inputs({
      uiViewsV2: [binding('review'), binding('review')],
    }))).toThrow("Duplicate UI destination binding 'acme.review:review'");
    expect(() => createResolvedContributionRegistry(inputs({
      uiSettingsPagesV2: [binding('settings'), binding('settings')],
    }))).toThrow("Duplicate UI destination binding 'acme.review:settings'");
    expect(() => createResolvedContributionRegistry(inputs({
      uiViewsV2: [binding('shared')],
      uiSettingsPagesV2: [binding('shared')],
    }))).toThrow("Duplicate UI destination binding 'acme.review:shared'");
    expect(() => createResolvedContributionRegistry(inputs({
      uiRenderersV2: [binding('renderer'), binding('renderer')],
    }))).toThrow("Duplicate UI renderer binding 'acme.review:renderer'");
  });

  it('preserves declarative voice model packs through the resolved registry', () => {
    const voiceModelPack = PluginContributesV2Schema.parse({ voiceModelPacks: [{
      id: 'english-small', schemaVersion: 1, executionHosts: ['daemon'],
      manifest: {
        schemaVersion: 1, kind: 'stt_sherpa', model: 'english-small', version: '1.0.0',
        runtime: {
          family: 'sherpa_zipformer_streaming',
          artifacts: {
            encoder: { type: 'file', path: 'encoder.onnx' }, decoder: { type: 'file', path: 'decoder.onnx' },
            joiner: { type: 'file', path: 'joiner.onnx' }, tokens: { type: 'file', path: 'tokens.txt' },
          },
          abiVersion: 1, minHostVersion: '1.0.0', platforms: ['darwin'], architectures: ['arm64'],
        },
        provenance: { source: 'https://models.example.test/english-small', publisher: 'Acme' },
        license: { id: 'Apache-2.0', title: 'Apache License 2.0', url: 'https://models.example.test/license', requiresAcceptance: false },
        files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((path, index) => ({
          path, url: `https://models.example.test/english-small/${path}`, sha256: String(index + 1).repeat(64), sizeBytes: 4,
        })),
      },
    }] }).voiceModelPacks[0]!;
    const common = {
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId: 'com.acme.voice',
      manifestPath: '/plugins/com.acme.voice/plugin.json',
      daemonEntryPath: '/plugins/com.acme.voice/daemon.js',
    };
    const registry = createResolvedContributionRegistry({
      agents: [],       voiceModelPacks: [{ ...common, identity: createPluginContributionIdentity({ pluginId: common.pluginId, localId: voiceModelPack.id }), definition: voiceModelPack }],
    });

    expect(registry.voiceModelPacks).toHaveLength(1);
    expect(registry.voiceProviders).toEqual([]);
  });
  it('indexes provider contributions by qualified contribution identity without colliding local ids', () => {
    const providerDefinition = {
      v: 1 as const,
      id: 'gateway',
      name: 'Gateway',
      kind: 'cloud' as const,
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses' as const,
        baseUrl: 'https://gateway.example/v1',
        capabilities: {
          streaming: 'unknown' as const,
          toolRoundTrips: 'unknown' as const,
          statefulResponses: 'unknown' as const,
          reasoningControls: 'unknown' as const,
        },
      }],
      catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
    };
    const provider = (pluginId: string) => ({
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId,
      manifestPath: `/plugins/${pluginId}/plugin.json`,
      daemonEntryPath: null,
      identity: {
        pluginId,
        localId: 'gateway',
      },
      definition: providerDefinition,
    });
    const registry = createResolvedContributionRegistry({
      agents: [],
            providers: [provider('acme.one'), provider('acme.two')],
    });

    expect(registry.providers).toHaveLength(2);
    expect([...registry.providersByContributionKey!.keys()]).toEqual([
      'acme.one/gateway',
      'acme.two/gateway',
    ]);
  });

  it('indexes built-in Agents and catalog entries without a parallel runtime index', () => {
    const registry = getResolvedContributionRegistry();
    const agentDefinitionIds = getAllAgentDefinitionContracts().map((entry) => entry.id).slice().sort();

    expect(Object.keys(registry.catalogEntriesById).slice().sort()).toEqual([...AGENT_IDS].slice().sort());
    expect(registry.agents.map((entry) => entry.definition.id).slice().sort()).toEqual(agentDefinitionIds);

    for (const agentId of AGENT_IDS) {
      expect(registry.agentDefinitionsById.get(agentId)?.id).toBe(agentId);
      expect(registry.agentDefinitionsById.get(agentId)?.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: agentId,
        }),
      );
      expect(registry.catalogEntriesById[agentId]?.id).toBe(agentId);
    }

    // A manifest-local CLI command may intentionally differ from the host's
    // canonical Agent identity. The registry keys by catalog id; it must not
    // rewrite or reject the independently authored command spelling.
    expect(registry.catalogEntriesById.ohMyPi?.cliSubcommand).toBe('ohmypi');

    expect(registry).not.toHaveProperty('agentRuntimes');
    expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
    expect(registry.agentDefinitionsById.get('codex')).not.toHaveProperty('getRuntimeCore');
  });

  it('exposes AI-agent definition index with agent vocabulary only', () => {
    const registry = getResolvedContributionRegistry();

    expect(registry.agentDefinitionsById.get('codex')?.id).toBe('codex');
    expect('providerDefinitionsById' in registry).toBe(false);
  });

  it('keeps the built-in snapshot isolated after priming merged contributes', async () => {
    const builtInRegistry = getResolvedContributionRegistry();
    expect(Object.keys(builtInRegistry.catalogEntriesById).slice().sort()).toEqual([...AGENT_IDS].slice().sort());

    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-prime-isolated-home-'));
    try {
      const mergedRegistry = await primeResolvedContributionRegistry({ happyHomeDir });
      expect(mergedRegistry.catalogEntriesById.codex?.id).toBe('codex');

      const builtInAfterPrime = getResolvedContributionRegistry();
      expect(Object.keys(builtInAfterPrime.catalogEntriesById).slice().sort()).toEqual([...AGENT_IDS].slice().sort());
      expect(builtInAfterPrime.catalogEntriesById['acme.ohmypi']).toBeUndefined();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('indexes action contributes in deterministic order on an immutable snapshot', () => {
    const registry = createResolvedContributionRegistry({
      agents: Object.freeze([
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
            actions: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'review-start',
            title: 'Beta Review',
            description: null,
            safety: 'safe',
            dangerLevel: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              agent: false,
              mcp: false,
              cli: true,
              rpc: false,
              api: false,
              plugin: false,
            },
            execution: { target: 'daemon' },
            inputHints: null,
            inputSchema: {},
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'review-start',
            title: 'Alpha Review',
            description: null,
            safety: 'safe',
            dangerLevel: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              agent: false,
              mcp: false,
              cli: true,
              rpc: false,
              api: false,
              plugin: false,
            },
            execution: { target: 'daemon' },
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
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            id: 'beta.plugin/review/ready',
            localId: 'review/ready',
            kind: 'event',
            title: 'Review ready',
            payloadSchema: {},
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.plugin/review/ready',
            localId: 'review/ready',
            kind: 'event',
            title: 'Review ready',
            payloadSchema: {},
          },
        },
      ]),
      requestInterceptors: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            id: 'beta.policy',
            priority: 20,
            origins: ['https://beta.example.test'],
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.policy',
            priority: 10,
            origins: ['https://alpha.example.test'],
          },
        },
      ]),
    });
    const actionIndexedRegistry = registry as typeof registry & Readonly<{
      actionsById: ReadonlyMap<string, unknown>;
      eventsById: ReadonlyMap<string, unknown>;
    }>;

    expect(registry.actions.map((action) => [action.pluginId, action.definition.id])).toEqual([
      ['alpha.plugin', 'review-start'],
      ['beta.plugin', 'review-start'],
    ]);
    expect(actionIndexedRegistry.actionsById.get('alpha.plugin/review-start')).toMatchObject({
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
    expect(registry).not.toHaveProperty('generationId');
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.actions)).toBe(true);
  });

  it('indexes event contributes by canonical plugin-qualified id when local ids match', () => {
    const registry = createResolvedContributionRegistry({
      agents: Object.freeze([]),
            events: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'task/complete',
            localId: 'task/complete',
            kind: 'event',
            title: 'Task complete',
            payloadSchema: {},
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            id: 'task/complete',
            localId: 'task/complete',
            kind: 'event',
            title: 'Task complete',
            payloadSchema: {},
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

  it('derives only current, exact plugin Event setup Actions without activating a plugin', () => {
    const action = (
      pluginId: string,
      id: string,
      title: string,
      contract: 'setup' | 'historyGapReset' = 'setup',
    ) => ({
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId,
      manifestPath: `/plugins/${pluginId}/plugin.json`,
      daemonEntryPath: `/plugins/${pluginId}/daemon.mjs`,
      definition: {
        kindVersion: 1 as const,
        id,
        title,
        description: null,
        safety: 'safe' as const,
        dangerLevel: 'safe' as const,
        placements: [],
        slash: null,
        bindings: null,
        examples: null,
        surfaces: {
          ui: false,
          voice: false,
          agent: false,
          mcp: false,
          cli: false,
          rpc: false,
          api: false,
          plugin: true,
        },
        execution: { target: 'daemon' },
        inputHints: null,
        inputSchema: contract === 'historyGapReset'
          ? PluginEventAutomationHistoryGapResetActionInputV1JsonSchema
          : { type: 'object', additionalProperties: false },
        outputSchema: contract === 'historyGapReset'
          ? PluginEventAutomationHistoryGapResetActionResultV1JsonSchema
          : createPluginEventAutomationSetupResultV1JsonSchema(
            1,
            { type: 'object', additionalProperties: false },
          ),
      },
    });
    const event = (
      pluginId: string,
      localId: string,
      setupActionLocalId?: string,
      historyGapResetActionLocalId?: string,
    ) => ({
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId,
      manifestPath: `/plugins/${pluginId}/plugin.json`,
      daemonEntryPath: `/plugins/${pluginId}/daemon.mjs`,
      definition: {
        id: `${pluginId}/${localId}`,
        localId,
        kind: 'event' as const,
        title: `${pluginId} event`,
        description: `${pluginId} description`,
        payloadSchema: { type: 'object', additionalProperties: false },
        automation: {
          v: 1 as const,
          eligible: true as const,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull' as const],
            sourceConfigSchema: { type: 'object', additionalProperties: false },
            ...(setupActionLocalId
              ? { setupActionRef: { pluginId, localId: setupActionLocalId } }
              : {}),
            ...(historyGapResetActionLocalId
              ? { historyGapResetActionRef: { pluginId, localId: historyGapResetActionLocalId } }
              : {}),
          },
        },
      },
    });
    const inputs = {
      agents: [],
      actions: [
        action('alpha.plugin', 'configure-source', 'Alpha setup'),
        action('alpha.plugin', 'baseline-history-gap', 'Resume source', 'historyGapReset'),
        action('beta.plugin', 'configure-source', 'Beta setup'),
      ],
      events: [
        event('alpha.plugin', 'repository/updated', 'configure-source', 'baseline-history-gap'),
        event('beta.plugin', 'repository/updated', 'configure-source'),
        event('alpha.plugin', 'valid-but-not-composer-eligible', 'missing-setup-action'),
      ],
      immutableGenerationIdsByPluginId: {
        'alpha.plugin': 'alpha-immutable-generation',
        'beta.plugin': 'beta-immutable-generation',
      },
    };

    const registry = createResolvedContributionRegistry(inputs);

    expect(registry.activationTargets).toEqual([]);
    expect(registry.automationEligibleEvents).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          id: 'alpha.plugin/repository/updated',
          identity: { pluginId: 'alpha.plugin', localId: 'repository/updated' },
          immutableGenerationId: 'alpha-immutable-generation',
        }),
        setupAction: expect.objectContaining({
          id: 'alpha.plugin/configure-source',
          identity: { pluginId: 'alpha.plugin', localId: 'configure-source' },
          immutableGenerationId: 'alpha-immutable-generation',
          title: 'Alpha setup',
        }),
        historyGapResetAction: expect.objectContaining({
          id: 'alpha.plugin/baseline-history-gap',
          identity: { pluginId: 'alpha.plugin', localId: 'baseline-history-gap' },
          immutableGenerationId: 'alpha-immutable-generation',
          title: 'Resume source',
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          id: 'beta.plugin/repository/updated',
          immutableGenerationId: 'beta-immutable-generation',
        }),
        setupAction: expect.objectContaining({
          id: 'beta.plugin/configure-source',
          title: 'Beta setup',
        }),
      }),
    ]);

    const staleGeneration = createResolvedContributionRegistry({
      ...inputs,
      immutableGenerationIdsByPluginId: {
        'alpha.plugin': 'alpha-immutable-generation',
      },
    });
    expect(staleGeneration.automationEligibleEvents?.map((entry) => entry.event.id)).toEqual([
      'alpha.plugin/repository/updated',
    ]);

    const removedAction = createResolvedContributionRegistry({
      ...inputs,
      actions: [action('beta.plugin', 'configure-source', 'Beta setup')],
    });
    expect(removedAction.automationEligibleEvents?.map((entry) => entry.event.id)).toEqual([
      'beta.plugin/repository/updated',
    ]);

    const removedRecoveryAction = createResolvedContributionRegistry({
      ...inputs,
      actions: [
        action('alpha.plugin', 'configure-source', 'Alpha setup'),
        action('beta.plugin', 'configure-source', 'Beta setup'),
      ],
    });
    expect(removedRecoveryAction.automationEligibleEvents?.[0]).toMatchObject({
      event: { id: 'alpha.plugin/repository/updated' },
    });
    expect(removedRecoveryAction.automationEligibleEvents?.[0]?.historyGapResetAction).toBeUndefined();
  });

  it('rejects duplicate event local ids within the same plugin', () => {
    expect(() => createResolvedContributionRegistry({
      agents: Object.freeze([]),
            events: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.plugin/task/complete',
            localId: 'task/complete',
            kind: 'event',
            title: 'Task complete',
            payloadSchema: {},
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.plugin/task/done',
            localId: 'task/complete',
            kind: 'event',
            title: 'Task complete',
            payloadSchema: {},
          },
        },
      ]),
    })).toThrow("Duplicate event contribution 'alpha.plugin/task/complete' from plugin 'alpha.plugin'");
  });

  it('rejects duplicate settings field ids within a single plugin namespace', () => {
    expect(() => createResolvedContributionRegistry({
      agents: Object.freeze([]),
            settings: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'settings-one',
            version: 1,
            title: 'Settings one',
            target: { kind: 'plugin' },
            scope: 'daemon',
            fields: [
              {
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string' },
              },
            ],
            presentation: { sections: [], subagentSections: [] },
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'settings-two',
            version: 1,
            title: 'Settings two',
            target: { kind: 'plugin' },
            scope: 'daemon',
            fields: [
              {
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string' },
              },
            ],
            presentation: { sections: [], subagentSections: [] },
          },
        },
      ]),
    })).toThrow("Duplicate settings field 'endpoint' for plugin 'alpha.plugin'");
  });

  it('keeps generic settings field ids plugin-local instead of requiring plugin-id prefixes', () => {
    const registry = createResolvedContributionRegistry({
      agents: Object.freeze([]),
            settings: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'settings',
            version: 1,
            title: 'Settings',
            target: { kind: 'plugin' },
            scope: 'daemon',
            fields: [
              {
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string' },
              },
            ],
            presentation: { sections: [], subagentSections: [] },
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'beta.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            id: 'settings',
            version: 1,
            title: 'Settings',
            target: { kind: 'plugin' },
            scope: 'daemon',
            fields: [
              {
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string' },
              },
            ],
            presentation: { sections: [], subagentSections: [] },
          },
        },
      ]),
    });

    expect(registry.settingsById?.get('alpha.plugin/settings')?.definition.fields[0]?.id).toBe('endpoint');
    expect(registry.settingsById?.get('beta.plugin/settings')?.definition.fields[0]?.id).toBe('endpoint');
  });

  it('merges installed plugin settings with bundled settings contributions', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-merge-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-settings-merge-plugin-'));

    try {
      await writeInstalledSettingsPlugin({
        happyHomeDir,
        pluginRoot,
        pluginId: 'acme.settings.merge',
        settingsId: 'main',
      });

      const registry = await resolveMergedContributionRegistry({ happyHomeDir });

      expect(registry.settingsById?.get('happier.inspector/settings')?.pluginId).toBe('happier.inspector');
      expect(registry.settingsById?.get('acme.settings.merge/main')).toMatchObject({
        pluginId: 'acme.settings.merge',
        definition: expect.objectContaining({
          id: 'main',
        }),
      });
      expect(registry.settings?.map((setting) => setting.definition.id)).toEqual(expect.arrayContaining([
        'settings',
        'main',
      ]));
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('preserves bundled MCP contribution families through the merged registry', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-mcp-merge-home-'));

    try {
      const registry = await resolveMergedContributionRegistry({ happyHomeDir });

      expect(registry.mcpDiscoverySources?.map((entry) => [
        entry.pluginId,
        entry.definition.id,
      ])).toEqual([
        ['happier.agent.claude', 'config'],
        ['happier.agent.codex', 'config'],
        ['happier.agent.opencode', 'config'],
      ]);
      expect(registry.mcpServers).toEqual([]);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate action ids before they can reach host action surfaces', () => {
    expect(() => createResolvedContributionRegistry({
      agents: Object.freeze([]),
            actions: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'review-start',
            title: 'Alpha Review',
            description: null,
            safety: 'safe',
            dangerLevel: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              agent: false,
              mcp: false,
              cli: true,
              rpc: false,
              api: false,
              plugin: false,
            },
            execution: { target: 'daemon' },
            inputHints: null,
            inputSchema: {},
          },
        },
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.plugin',
          manifestPath: '/plugins/beta/plugin.json',
          daemonEntryPath: '/plugins/beta/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'review-start',
            title: 'Beta Review',
            description: null,
            safety: 'safe',
            dangerLevel: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              agent: false,
              mcp: false,
              cli: true,
              rpc: false,
              api: false,
              plugin: false,
            },
            execution: { target: 'daemon' },
            inputHints: null,
            inputSchema: {},
          },
        },
      ]),
    })).toThrow("Duplicate action contribution 'acme.plugin/review-start'");
  });

  it('indexes tool, command, and lifecycle-handler definitions alongside action contributes', () => {
    const registry = createResolvedContributionRegistry({
      agents: Object.freeze([
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
            actions: Object.freeze([]),
      tools: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.plugin',
          manifestPath: '/plugins/acme/plugin.json',
          daemonEntryPath: '/plugins/acme/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'tool',
            name: 'acme_tool',
            title: 'Acme Tool',
            description: 'Runs the Acme tool',
            safety: 'safe',
            surfaces: ['cli', 'mcp'],
            inputSchema: {},
            action: 'tool',
            actionId: 'tool',
          },
        },
      ]),
      commands: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.plugin',
          manifestPath: '/plugins/acme/plugin.json',
          daemonEntryPath: '/plugins/acme/daemon.mjs',
          definition: {
            kindVersion: 1,
            id: 'command',
            title: 'Acme review',
            description: 'Run the Acme review command',
            path: ['acme-review'],
            action: 'command',
            tmux: 'forbidden',
            actionId: 'command',
          },
        },
      ]),
    });

    expect(registry.tools?.map((tool) => tool.definition.id)).toEqual(['tool']);
    expect(registry.commands?.map((command) => command.definition.id)).toEqual(['command']);
    expect(registry.toolsById?.get('acme.plugin/tool')).toMatchObject({
      pluginId: 'acme.plugin',
    });
    expect(registry.commandsById?.get('acme.plugin/command')).toMatchObject({
      pluginId: 'acme.plugin',
    });
    expect(registry).not.toHaveProperty('generationId');
  });

  it('does not admit the retired static hook-registration input', () => {
    const validHook: ResolvedActivatedHookRegistration = {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'acme.hooks',
      manifestPath: '/plugins/acme/plugin.json',
      daemonEntryPath: '/plugins/acme/daemon.mjs',
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/acme',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      definition: {
        hookApiVersion: 1,
        id: 'session.spawned',
        category: 'lifecycle',
        scope: 'session',
        executionKind: 'observe',
      },
    };
    const staleHook: ResolvedActivatedHookRegistration = {
      ...validHook,
      definition: {
        ...validHook.definition,
        id: 'provider.request.before',
      },
    };

    const registry = createResolvedContributionRegistry({
      agents: Object.freeze([]),
            actions: Object.freeze([]),
      resources: Object.freeze([]),
      activationTargets: Object.freeze([]),
      hookRegistrations: Object.freeze([validHook, staleHook]),
    } as unknown as Parameters<typeof createResolvedContributionRegistry>[0]);

    expect(registry).not.toHaveProperty('hookRegistrations');
    expect(registry.pluginDiagnosticsByPluginId['acme.hooks']).toBeUndefined();
  });

  it('keys plugin resources by qualified contribution identity', () => {
    const resource = (pluginId: string) => ({
      provenance: 'first_party' as const,
      source: { kind: 'bundled' as const },
      pluginId,
      definition: {
        kindVersion: 1 as const,
        id: 'review-prompt-resource',
        type: 'prompt',
        path: './resources/review-prompt.md',
      },
    });

    const registry = createResolvedContributionRegistry({
      resources: [resource('happier.review.coderabbit'), resource('happier.review.deepsec')],
    });

    expect([...registry.resourcesById!.keys()].sort()).toEqual([
      'happier.review.coderabbit/review-prompt-resource',
      'happier.review.deepsec/review-prompt-resource',
    ]);
  });

  it('orders and keys prompt assets by qualified identity and rejects an active duplicate', () => {
    const promptAsset = (pluginId: string, priority: number) => ({
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId,
      identity: createPluginContributionIdentity({ pluginId, localId: 'instructions' }),
      manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
      daemonEntryPath: null,
      sourceSpec: { kind: 'path' as const, locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted' as const, installPolicy: 'link' as const },
      definition: {
        id: 'instructions', kind: 'systemPrompt' as const, resource: 'body',
        target: { kind: 'agent' as const, agent: { pluginId: 'acme.agent', localId: 'worker' } },
        priority,
      },
    });
    const alpha = promptAsset('acme.alpha', 20);
    const beta = promptAsset('acme.beta', 10);
    const registry = createResolvedContributionRegistry({ promptAssets: [alpha, beta] });

    expect((registry.promptAssets ?? []).map((asset) => asset.pluginId)).toEqual(['acme.beta', 'acme.alpha']);
    expect([...registry.promptAssetsById!.keys()]).toEqual(['acme.beta/instructions', 'acme.alpha/instructions']);
    expect(() => createResolvedContributionRegistry({ promptAssets: [alpha, alpha] }))
      .toThrow("Duplicate prompt asset contribution 'acme.alpha/instructions'");
  });
});
