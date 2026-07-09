import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  resolveMergedContributionRegistry,
} from './createResolvedContributionRegistry';
import { createPluginStateStore } from '@/plugins/store/state';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { ResolvedHookRegistration, ResolvedReactNativeBundleContribution } from './types';

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
      uses: ['settings'],
      contributes: {
        settings: [
          {
            id: params.settingsId,
            fields: [
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                control: 'text',
                displayKey: 'plugins.acmeSettingsMerge.endpoint.label',
                clearWhenEmpty: 'persist',
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

describe('getResolvedContributionRegistry', () => {
  it('indexes built-in agent, backend, and catalog entries through one resolved registry', () => {
    const registry = getResolvedContributionRegistry();
    const backendDefinitionIds = getAllBackendDefinitionContracts().map((entry) => entry.id).slice().sort();
    const agentDefinitionIds = getAllProviderDefinitionContracts().map((entry) => entry.id).slice().sort();

    expect(Object.keys(registry.catalogEntriesById).slice().sort()).toEqual([...AGENT_PROVIDER_IDS].slice().sort());
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

    for (const backendId of backendDefinitionIds) {
      expect(registry.agentRuntimeDefinitionsById.get(backendId)?.id).toBe(backendId);
      expect(registry.agentRuntimeDefinitionsById.get(backendId)?.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: backendId,
          agentId: backendId,
        }),
      );
    }

    expect(registry.agentRuntimeDefinitionsById.get('codex')).not.toHaveProperty('getRuntimeCore');
  });

  it('exposes AI-agent definition index with agent vocabulary only', () => {
    const registry = getResolvedContributionRegistry();

    expect(registry.agentDefinitionsById.get('codex')?.id).toBe('codex');
    expect('providerDefinitionsById' in registry).toBe(false);
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
      agentRuntimes: Object.freeze([]),
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
              agent: false,
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
              agent: false,
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
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
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

  it('builds registry identity for development RN dev-hot-reload artifacts without immutable digests', () => {
    const registry = createResolvedContributionRegistry({
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
      reactNativeBundles: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.preview',
          manifestPath: '/plugins/acme/plugin.json',
          manifestDigest: 'sha256:plugin',
          daemonEntryPath: '/plugins/acme/daemon.mjs',
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          definition: {
            id: 'native-preview',
            bundle: {
              platform: 'ios',
              channel: 'development',
            },
            entry: { modulePath: './renderSurface', exportName: 'renderSurface' },
            compatibility: {
              hostUiApiVersion: '1.0.0',
              reactVersion: '19.0.0',
              reactNativeVersion: '0.83.4',
              supportedPlatforms: ['ios'],
              supportedChannels: ['development'],
              requiredNativeCapabilities: [],
            },
            hostApi: { minVersion: '1.0.0', methods: [] },
            nativeCapabilities: [],
            fallback: { kind: 'none' },
            display: {
              titleKey: 'title',
              descriptionKey: 'description',
              iconToken: 'preview',
              tone: 'info',
            },
            policy: { allowDevHotReload: true },
          },
        },
      ]),
      uiArtifacts: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.preview',
          manifestPath: '/plugins/acme/plugin.json',
          manifestDigest: 'sha256:plugin',
          daemonEntryPath: '/plugins/acme/daemon.mjs',
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          definition: {
            id: 'native-preview-ios-dev',
            contributionId: 'native-preview',
            contributionFamily: 'reactNativeBundles',
            artifactKind: 'reactNativeBundle',
            platform: 'ios',
            channel: 'development',
            compatibility: {
              hostAppVersion: '2.0.0',
              hostUiApiVersion: '1.0.0',
              reactVersion: '19.0.0',
              reactNativeVersion: '0.83.4',
              nativeCapabilities: [],
            },
            byteSize: 0,
            contentType: 'application/javascript',
            devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true',
          },
        },
      ]),
    });

    expect(registry.generationId).toContain('devUrl:http://127.0.0.1:8082/index.bundle?platform=ios&dev=true');
  });

  // NATIVE-PIPELINE (LEDGER DEC-6 follow-up, item 1): a `reactNative` surface
  // is one logical `id` with an additional bundle entry per platform (mirrors
  // the pre-existing ios+android multi-entry manifest-artifact pattern). The
  // registry's dedupe key is `pluginId:id:platform`, not `pluginId:id`.
  function buildReactNativeBundleContribution(platform: 'ios' | 'web'): ResolvedReactNativeBundleContribution {
    return {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'acme.preview',
      manifestPath: '/plugins/acme/plugin.json',
      manifestDigest: 'sha256:plugin',
      daemonEntryPath: '/plugins/acme/daemon.mjs',
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/acme',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      definition: {
        id: 'native-preview',
        bundle: { platform, channel: 'development' },
        entry: { modulePath: './renderSurface', exportName: 'renderSurface' },
        compatibility: {
          hostUiApiVersion: '1.0.0',
          reactVersion: '19.0.0',
          reactNativeVersion: '0.83.4',
          supportedPlatforms: [platform],
          supportedChannels: ['development'],
          requiredNativeCapabilities: [],
        },
        hostApi: { minVersion: '1.0.0', methods: [] },
        nativeCapabilities: [],
        fallback: { kind: 'none' },
        display: {
          titleKey: 'title',
          descriptionKey: 'description',
          iconToken: 'preview',
          tone: 'info',
        },
        policy: { allowDevHotReload: true },
      },
    };
  }

  it('allows two reactNativeBundles contributions sharing one id when their platforms differ', () => {
    const registry = createResolvedContributionRegistry({
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
      reactNativeBundles: Object.freeze([
        buildReactNativeBundleContribution('ios'),
        buildReactNativeBundleContribution('web'),
      ]),
    });

    expect(registry.reactNativeBundles).toHaveLength(2);
    expect(registry.reactNativeBundlesById?.get('acme.preview:native-preview:ios')).toMatchObject({
      definition: { bundle: { platform: 'ios' } },
    });
    expect(registry.reactNativeBundlesById?.get('acme.preview:native-preview:web')).toMatchObject({
      definition: { bundle: { platform: 'web' } },
    });
  });

  it('rejects two reactNativeBundles contributions sharing one id AND platform', () => {
    expect(() => createResolvedContributionRegistry({
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
      reactNativeBundles: Object.freeze([
        buildReactNativeBundleContribution('ios'),
        buildReactNativeBundleContribution('ios'),
      ]),
    })).toThrow(/Duplicate React Native bundle contribution 'acme\.preview:native-preview:ios'/);
  });

  it('rejects duplicate event local ids within the same plugin', () => {
    expect(() => createResolvedContributionRegistry({
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
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

  it('rejects duplicate settings field ids within a single plugin namespace', () => {
    expect(() => createResolvedContributionRegistry({
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
      settings: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha-one',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.plugin.settings.one',
            fields: [
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
	                valueSchema: { type: 'string' },
	                control: 'text',
	                displayKey: 'plugins.alpha.endpoint.label',
	                capabilityGates: [],
	                permissionGates: [],
	                redaction: 'none',
	                hidden: false,
	                clearWhenEmpty: 'persist',
	              },
            ],
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
            id: 'alpha.plugin.settings.two',
            fields: [
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
	                valueSchema: { type: 'string' },
	                control: 'text',
	                displayKey: 'plugins.alpha.endpoint.label',
	                capabilityGates: [],
	                permissionGates: [],
	                redaction: 'none',
	                hidden: false,
	                clearWhenEmpty: 'persist',
	              },
            ],
          },
        },
      ]),
    })).toThrow("Duplicate settings field 'endpoint' for plugin 'alpha.plugin'");
  });

  it('keeps generic settings field ids plugin-local instead of requiring plugin-id prefixes', () => {
    const registry = createResolvedContributionRegistry({
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
      settings: Object.freeze([
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'alpha.plugin',
          manifestPath: '/plugins/alpha/plugin.json',
          manifestDigest: 'sha256:alpha',
          daemonEntryPath: '/plugins/alpha/daemon.mjs',
          definition: {
            id: 'alpha.plugin.settings',
            fields: [
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
	                valueSchema: { type: 'string' },
	                control: 'text',
	                displayKey: 'plugins.alpha.endpoint.label',
	                capabilityGates: [],
	                permissionGates: [],
	                redaction: 'none',
	                hidden: false,
	                clearWhenEmpty: 'persist',
	              },
            ],
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
            id: 'beta.plugin.settings',
            fields: [
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
	                valueSchema: { type: 'string' },
	                control: 'text',
	                displayKey: 'plugins.beta.endpoint.label',
	                capabilityGates: [],
	                permissionGates: [],
	                redaction: 'none',
	                hidden: false,
	                clearWhenEmpty: 'persist',
	              },
            ],
          },
        },
      ]),
    });

    expect(registry.settingsById?.get('alpha.plugin.settings')?.definition.fields[0]?.id).toBe('endpoint');
    expect(registry.settingsById?.get('beta.plugin.settings')?.definition.fields[0]?.id).toBe('endpoint');
  });

  it('merges installed plugin settings with bundled settings contributions', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-merge-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-settings-merge-plugin-'));

    try {
      await writeInstalledSettingsPlugin({
        happyHomeDir,
        pluginRoot,
        pluginId: 'acme.settings.merge',
        settingsId: 'acme.settings.merge.main',
      });

      const registry = await resolveMergedContributionRegistry({ happyHomeDir });

      expect(registry.settingsById?.get('happier.inspector.settings')?.pluginId).toBe('happier.inspector');
      expect(registry.settingsById?.get('acme.settings.merge.main')).toMatchObject({
        pluginId: 'acme.settings.merge',
        definition: expect.objectContaining({
          id: 'acme.settings.merge.main',
        }),
      });
      expect(registry.settings?.map((setting) => setting.definition.id)).toEqual(expect.arrayContaining([
        'happier.inspector.settings',
        'acme.settings.merge.main',
      ]));
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('rejects installed plugin settings ids that collide with bundled settings', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-merge-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-settings-merge-plugin-'));

    try {
      await writeInstalledSettingsPlugin({
        happyHomeDir,
        pluginRoot,
        pluginId: 'acme.settings.collision',
        settingsId: 'happier.inspector.settings',
      });

      await expect(resolveMergedContributionRegistry({ happyHomeDir }))
        .rejects
        .toThrow("Duplicate settings contribution 'happier.inspector.settings'");
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('rejects duplicate action ids before they can reach host action surfaces', () => {
    expect(() => createResolvedContributionRegistry({
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
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
              agent: false,
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
              agent: false,
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
      agentRuntimes: Object.freeze([]),
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
              agent: false,
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
        id: 'subagent.started',
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
      agents: Object.freeze([]),
      agentRuntimes: Object.freeze([]),
      actions: Object.freeze([]),
      resources: Object.freeze([]),
      uiDescriptors: Object.freeze([]),
      activationTargets: Object.freeze([]),
      hookRegistrations: Object.freeze([validHook, staleHook]),
    });

    expect(registry.hookRegistrations.map((hook) => hook.definition.id)).toEqual(['subagent.started']);
    expect(registry.pluginDiagnosticsByPluginId['acme.hooks']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
      }),
    ]);
  });
});
