import { describe, expect, it } from 'vitest';
import { PluginCompatibilityDiagnosticSchema } from '@/plugins/validation/diagnostics/types';
import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui';
import { PluginProjectedActionInputHintsV2Schema } from '@happier-dev/protocol';

import { buildPluginContributionRegistry } from './package';
import { projectSelectedLoadedPluginContributes } from '../selected';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createListExtensionSource } from '../../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/list-extension-source';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../fullProjection';
import { projectPluginUiDeclarationEntries } from '../ui/projection';
import { admitPluginContributionGraph } from './admission';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../../../../packages/plugins/deepseek/src/provider/contribution';

function loaded(
  pluginId: string,
  contributes: Record<string, unknown>,
  generatedUiArtifactsManifest?: LoadedPlugin['generatedUiArtifactsManifest'],
  manifestFields?: Record<string, unknown>,
): LoadedPlugin {
  return {
    pluginId,
    pluginRootPath: `/plugins/${pluginId}`,
    manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
    daemonEntryPath: `/plugins/${pluginId}/dist/plugin.js`,
    devDaemonEntryPath: null,
    sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted', installPolicy: 'link' },
    ...(generatedUiArtifactsManifest ? { generatedUiArtifactsManifest } : {}),
    manifest: normalizePluginManifestV2({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: pluginId,
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      ...manifestFields,
      contributes,
    }),
  };
}

it('keeps producer-backed database Actions on the generic CLI catalogue with declared input custody', async () => {
  const { definePlugin } = await import('@happier-dev/plugin-sdk');
  const { createDatabaseActions } = await import('../../../../../../../packages/plugins/database-workbench/src/actions');
  const { DATABASE_STATEMENT_RUN_ACTION_ID_V1, databaseActionLocalIdV1 } = await import('@happier-dev/database-protocol');
  const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', displayName: 'Database',
    actions: createDatabaseActions({ executeOperation: () => ({ ok: false, status: 'unavailable',
      code: 'database_unavailable', reason: 'No driver in a declaration test' }) }),
  });
  const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded(plugin.manifest.id, plugin.manifest.contributes)] });
  const run = registry.actions.find(action => action.identity.localId === databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1));
  expect(run?.definition.surfaces).toMatchObject({ cli: true, ui: true, plugin: true, agent: false, mcp: false });
  expect(run?.definition.readOnly).toEqual({ op: 'eq', path: 'mode', value: 'read' });
  expect(run?.definition.approvalInputCustody).toBe('live_only');
  expect(run?.definition.secretInputPaths).toEqual(['statement.parameters.[].value', 'statements.[].parameters.[].value']);
});

it('keeps conditional mutations visible in the static Action effect catalog', async () => {
  const { definePlugin } = await import('@happier-dev/plugin-sdk');
  const common = { title: 'Catalog effect', dangerLevel: 'safe', run: () => {} } as const;
  const plugin = definePlugin({ id: 'example.effect-catalog', version: '1.0.0', actions: {
    conditional: { ...common, readOnly: { op: 'eq', path: 'mode', value: 'preview' } },
    read: { ...common, readOnly: true }, effect: { ...common, readOnly: false }, undeclared: common,
  } });
  const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded(plugin.manifest.id, plugin.manifest.contributes)] });
  const effects = Object.fromEntries(registry.actions.map(action => [action.identity.localId, action.definition.sideEffectClass]));
  expect(effects).toEqual({ conditional: 'external', read: 'read', effect: 'external', undeclared: undefined });
});

function bundledAgentWithConnectedAccounts(
  pluginId: string,
  connectedAccounts: readonly Readonly<{
    purpose: string;
    required?: boolean;
    service: Readonly<{ pluginId: string; localId: string }>;
  }>[],
): LoadedPlugin {
  const plugin = loaded(pluginId, {
    agents: [{
      id: 'consumer',
      title: 'Consumer',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        surfaces: ['terminal'],
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
      connectedAccounts,
    }],
  });
  return {
    ...plugin,
    sourceSpec: {
      kind: 'bundled',
      locator: `@happier-dev/${pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
  };
}

describe('target package contribution projection', () => {
  it.each([false, true])('uses supplied enablement for fallback account references (enabled=%s)', (enabled) => {
    const account = loaded('com.acme.accounts', { connectedAccountDescriptors: [{
      id: 'github', title: 'GitHub', authentication: {
        defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
          fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }] }],
      },
    }] });
    const service = { pluginId: account.pluginId, localId: 'github' };
    const agent = bundledAgentWithConnectedAccounts('com.acme.consumer', [{ purpose: 'api', required: false, service }]);
    const registry = buildPluginContributionRegistry({ loadedPlugins: [agent],
      referenceGraph: admitPluginContributionGraph({ loadedPlugins: [account] }),
      pluginEnablementById: { [account.pluginId]: { enabled, machineEnabled: enabled } },
    });
    expect(registry.agents).toHaveLength(1);
    expect(registry.agents[0]?.definition.connectedAccounts).toEqual(enabled
      ? [expect.objectContaining({ service })] : []);
    if (!enabled) expect(registry.admittedGraph.diagnosticsByPluginId[agent.pluginId]).toMatchObject([{
      code: 'plugin_optional_reference_unavailable', details: {
        unavailableSource: { pluginId: account.pluginId, code: 'plugin_disabled' },
      },
    }]);
  });
  it.each(['full', 'selected'] as const)('reuses admitted Provider definitions during %s projection', (mode) => {
    const plugin = loaded('com.acme.provider', { providers: [DEEPSEEK_PROVIDER_CONTRIBUTION] });
    const admittedGraph = admitPluginContributionGraph({ loadedPlugins: [plugin] });
    const admitted = admittedGraph.loadedPlugins[0]!;
    const definition = admitted.manifest.contributes.providers[0]!;
    const registry = mode === 'full'
      ? buildPluginContributionRegistry({ loadedPlugins: [admitted], admittedGraph })
      : projectSelectedLoadedPluginContributes({
        loadResult: { loadedPlugins: [admitted], diagnosticsByPluginId: {} },
        provenance: 'first_party', admittedGraph,
        providerContributionKeys: ['com.acme.provider/deepseek'],
      });
    // Ingress already parsed this definition. A second parse copies its schema
    // graph and inflates startup allocation without adding an admission decision.
    expect(registry.providers?.[0]?.definition).toBe(definition);
  });

  it('projects an exact Provider without reading unrelated admitted declarations and observes a changed definition', () => {
    const plugin = loaded('com.acme.provider', { providers: [DEEPSEEK_PROVIDER_CONTRIBUTION,
      ...Array.from({ length: 100 }, (_, index) => ({ ...DEEPSEEK_PROVIDER_CONTRIBUTION, id: `other-${index}` })),
    ] });
    let unrelatedReads = 0;
    const peer = loaded('com.acme.prov', { providers: [DEEPSEEK_PROVIDER_CONTRIBUTION] });
    const admittedGraph = admitPluginContributionGraph({ loadedPlugins: [plugin, peer] });
    const current = admittedGraph.loadedPlugins[0]!;
    const contributes = new Proxy(current.manifest.contributes, {
      get(target, key, receiver) {
        if (key !== 'providers') unrelatedReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const observed = { ...current, manifest: { ...current.manifest, contributes } };
    let unrelatedPluginReads = 0;
    const admittedPeer = admittedGraph.loadedPlugins[1]!;
    const unrelated = { ...admittedPeer, manifest: { ...admittedPeer.manifest,
      contributes: new Proxy(admittedPeer.manifest.contributes, { get(target, key, receiver) {
        unrelatedPluginReads++;
        return Reflect.get(target, key, receiver);
      } }) } };
    const params = { loadedPlugins: [observed, unrelated], admittedGraph: { ...admittedGraph, loadedPlugins: [observed, unrelated] },
      providerContributionKeys: ['com.acme.provider/deepseek'] };
    const project = (input: typeof params) => projectSelectedLoadedPluginContributes({
      loadResult: { loadedPlugins: input.loadedPlugins, diagnosticsByPluginId: {} },
      provenance: 'first_party', admittedGraph: input.admittedGraph,
      providerContributionKeys: input.providerContributionKeys,
    });
    const registry = project(params);
    expect(registry.providers?.map(row => row.definition.name)).toEqual([DEEPSEEK_PROVIDER_CONTRIBUTION.name]);
    expect(unrelatedReads).toBe(0);
    expect(unrelatedPluginReads).toBe(0);
    const changed = { ...current, manifest: { ...current.manifest, contributes: { ...current.manifest.contributes,
      providers: [{ ...DEEPSEEK_PROVIDER_CONTRIBUTION, name: 'Changed Provider declaration' }] } } };
    expect(project({ ...params, loadedPlugins: [changed],
      admittedGraph: { ...admittedGraph, loadedPlugins: [changed] } }).providers?.[0]?.definition.name)
      .toBe('Changed Provider declaration');
  });

  it('does not reread admitted bundled manifests for an empty installed graph', () => {
    const admitted = admitPluginContributionGraph({ loadedPlugins: Array.from({ length: 100 }, (_, index) => loaded(`com.acme.peer${index}`, {})) });
    let manifestReads = 0;
    const referenceGraph = { ...admitted, loadedPlugins: admitted.loadedPlugins.map(plugin => ({
      ...plugin, get manifest() { manifestReads++; return plugin.manifest; },
    })) };
    expect(buildPluginContributionRegistry({ loadedPlugins: [], referenceGraph }).agents).toEqual([]);
    expect(manifestReads).toBe(0);
  });
  it('excludes only the invalid dependency closure, including bundled consumers of a replacement', () => {
    const action = { id: 'run', title: 'Run', scopes: ['global'], surfaces: ['ui'],
      execution: { target: 'daemon' }, placementBindings: ['commandPalette'], dangerLevel: 'safe' };
    const producer = loaded('com.acme.producer', { actions: [action] });
    const dependant = loaded('com.acme.dependant', { browserTargets: [{ id: 'page', title: 'Page', url: 'https://example.com' }], browserActions: [{
      id: 'use', title: 'Use', target: 'page', action: { pluginId: producer.pluginId, localId: 'run' },
    }] });
    const replacement = loaded(producer.pluginId, { browserTargets: [{ id: 'page', title: 'Page', url: 'https://example.com' }], browserActions: [{
      id: 'bad', title: 'Bad', target: 'page', action: { pluginId: 'com.acme.absent', localId: 'run' },
    }] });
    const healthy = loaded('com.acme.healthy', { actions: [action] });
    const registry = buildPluginContributionRegistry({ loadedPlugins: [replacement, healthy], referencePlugins: [producer, dependant] });
    expect(registry.actions.map(action => action.pluginId)).toEqual([healthy.pluginId]);
    expect(Object.keys(registry.admittedGraph.diagnosticsByPluginId).sort()).toEqual([dependant.pluginId, producer.pluginId]);
  });
  it.each(['loaded', 'reference'] as const)('rejects duplicate %s identities even when their fallback is replaced', (input) => {
    const first = loaded('happier.channels', {});
    const second = { ...first, pluginRootPath: '/plugins/another-channels-source' };
    expect(() => buildPluginContributionRegistry({
      loadedPlugins: input === 'loaded' ? [first, second] : [first],
      referencePlugins: input === 'reference' ? [first, second] : [first],
    })).toThrow(/Duplicate plugin identity 'happier\.channels'/u);
  });

  it('carries an external list extension from public authoring through normalization and the strict UI projection', () => {
    let resourceReads = 0;
    const source = createListExtensionSource(() => resourceReads++);
    expect(parsePluginManifest(source.manifest)).toMatchObject({ ok: true });
    const plugin = loaded(source.manifest.id, source.manifest.contributes ?? {});
    const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} }, provenance: 'external',
    }));
    expect(registry.uiListExtensionsV1).toMatchObject([{
      identity: { pluginId: source.manifest.id, localId: 'releases' },
      definition: { entity: 'sessionWork', rowMark: { fieldId: 'release-stage', slot: 'context' } },
    }]);
    expect(projectPluginUiDeclarationEntries(registry)['listExtension:com.acme.release:releases']).toMatchObject({
      contributionKind: 'listExtension', pluginId: source.manifest.id,
      listExtension: { entity: 'sessionWork' },
    });
    const retired = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [], diagnosticsByPluginId: {} }, provenance: 'external',
    }));
    expect(projectPluginUiDeclarationEntries(retired)['listExtension:com.acme.release:releases']).toBeUndefined();
    expect(resourceReads).toBe(0);
  });

  it('admits current UI declarations without retaining retired root contribution routes', () => {
    for (const root of ['hostedWeb', 'uiTranslations']) {
      expect(() => loaded('com.acme.ui', { [root]: [] })).toThrow();
    }
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.ui', {
        ui: { translations: [{ locale: 'en', messages: { greeting: 'Hello' } }] },
      })],
    });
    expect(registry.uiTranslationsV2[0]?.definition).toEqual({ locale: 'en', messages: { greeting: 'Hello' } });
    expect(registry).not.toHaveProperty('uiTranslations');
    expect(registry).not.toHaveProperty('hostedWeb');
  });

  it('projects every declared catalog family through the authoritative semantic inventory', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.locale', {
        resources: [{ id: 'copy-en', kind: 'asset', path: 'assets/i18n/en-US.json', contentType: 'application/json' }],
        ui: {
          translations: [{ locale: 'en-US', resourceId: 'copy-en' }],
        },
      })],
    });

    expect(registry.semanticContributionsByFamily.get('ui.translations')).toMatchObject([
      {
        pluginId: 'com.acme.locale',
        pluginVersion: '1.0.0',
        family: 'ui.translations',
        conflictKey: 'en-US',
        introspection: { localId: null },
        definition: { locale: 'en-US' },
      },
    ]);
    expect(registry.uiTranslationsV2[0]).not.toHaveProperty('identity');
  });

  it('materializes a declared composer reference with its Protocol-owned presentation', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.issues', {
        composerReferences: [{
          id: 'issues',
          title: 'Issues',
          description: 'Search project issues',
          icon: 'search',
          triggers: ['$'],
        }],
      })],
    });

    expect(registry.composerReferences).toMatchObject([{
      pluginId: 'com.acme.issues',
      identity: { pluginId: 'com.acme.issues', localId: 'issues' },
      definition: {
        id: 'issues',
        title: 'Issues',
        description: 'Search project issues',
        icon: 'search',
        triggers: ['$'],
      },
    }]);
  });

  it('preserves tool and CLI presentation on the canonical Action declaration', () => {
    const resultSchema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: false,
    } as const;
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.plugin', {
      actions: [{
        id: 'run',
        title: 'Run',
        scopes: ['session'],
        surfaces: ['cli'],
        execution: { target: 'daemon' },
        operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, additionalProperties: false },
        sessionTarget: { field: 'sessionId', cardinality: 'many' },
        placementBindings: ['primary'],
        resultSchema,
        tool: { name: 'runner', title: 'Runner' },
        toolExposure: { agent: 'discoverable_only', mcp: 'direct' },
        cli: { path: ['run'], aliases: [['execute']] },
        dangerLevel: 'writesRemote',
        confirmation: {
          title: { key: 'actions.run.title', fallback: 'Run remotely?' },
          confirmLabel: { key: 'actions.run.confirm', fallback: 'Run' },
        },
      }],
    })] });
    expect(registry.actions[0]?.admittedTarget.declaration).toMatchObject({
      id: 'run', tool: { name: 'runner', title: 'Runner' }, cli: { path: ['run'], aliases: [['execute']] },
    });
    expect(registry.actions[0]?.definition).toMatchObject({
      outputSchema: resultSchema,
      toolExposure: { agent: 'discoverable_only', mcp: 'direct' },
      bindings: { mcpToolName: 'runner' },
      sessionTarget: { field: 'sessionId', cardinality: 'many' },
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'actions.run.title', fallback: 'Run remotely?' },
        confirmLabel: { key: 'actions.run.confirm', fallback: 'Run' },
      },
    });
  });

  it('preserves UI as an explicit action surface without aliasing CLI', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.plugin', {
      actions: [{
        id: 'open',
        title: 'Open',
        icon: 'arrow-up-right',
        scopes: ['session'],
        surfaces: ['ui'],
        execution: { target: 'daemon' },
        placementBindings: ['detailsPanel'],
        dangerLevel: 'safe',
      }],
    })] });

    expect(registry.actions[0]?.definition.surfaces).toMatchObject({
      ui: true,
      cli: false,
      mcp: false,
      agent: false,
    });
    expect(registry.actions[0]?.definition.contributionSurfaces).toEqual(['ui']);
    expect(registry.actions[0]?.definition).toMatchObject({ icon: 'arrow-up-right' });
  });

  it('makes dynamically installed Actions API-eligible independently of author presentation surfaces', () => {
    const action = {
      id: 'inspect',
      title: 'Inspect',
      scopes: ['session'],
      surfaces: ['cli'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
    } as const;
    const external = loaded('com.acme.external-action', { actions: [action] });
    const bundled = {
      ...loaded('com.acme.bundled-action', { actions: [action] }),
      sourceSpec: {
        kind: 'bundled' as const,
        locator: '@happier-dev/acme-bundled-action',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
      },
    } satisfies LoadedPlugin;

    const registry = buildPluginContributionRegistry({
      loadedPlugins: [external, bundled],
    });

    for (const contribution of registry.actions) {
      expect(contribution.definition.surfaces).toMatchObject({
        api: true,
        cli: true,
      });
      expect(contribution.definition.surfaces).not.toHaveProperty('sdk');
    }
  });

  it('preserves the exact client execution target and Voice surface through the canonical Action projection', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.voice', {
      actions: [{
        id: 'start-voice-note',
        title: 'Start voice note',
        scopes: ['session'],
        surfaces: ['voice'],
        execution: {
          target: 'client',
          client: {
            artifactId: 'voice-client',
            exportName: 'registerVoiceAction',
          },
          platforms: ['web', 'ios'],
        },
        dangerLevel: 'safe',
      }],
    })] });

    expect(registry.actions[0]?.definition).toMatchObject({
      execution: {
        target: 'client',
        client: {
          artifactId: 'voice-client',
          exportName: 'registerVoiceAction',
        },
        platforms: ['web', 'ios'],
      },
      surfaces: { voice: true, cli: false, ui: false },
      contributionSurfaces: ['voice'],
    });
  });

  it('retains generated Artifact custody on the exact client Action that declares it', () => {
    const generatedUiArtifactsManifest = PluginUiArtifactsManifestV2Schema.parse({
      version: 2 as const,
      entries: [{
        artifactId: 'action-client-artifact',
        tier: 'reactNative' as const,
        entry: 'react-native/action-client-artifact/entry.cjs.bundle',
        files: [{
          relativePath: 'react-native/action-client-artifact/entry.cjs.bundle',
          digest: `sha256:${'2'.repeat(64)}`,
          byteSize: 1,
        }],
        digest: `sha256:${'1'.repeat(64)}`,
        builtWith: { bundler: 'esbuild' as const, version: '0.27.2' },
        executable: { exports: ['activate'] },
        hostUiApiRange: '^1.0.0',
      }],
    });
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.client-action', {
        actions: [{
          id: 'open-preview',
          title: 'Open preview',
          scopes: ['session'],
          surfaces: ['ui'],
          execution: {
            target: 'client',
            client: {
              artifactId: 'action-client-artifact',
              exportName: 'activate',
            },
            platforms: ['web'],
          },
          placementBindings: ['detailsPanel'],
          dangerLevel: 'safe',
        }],
      }, generatedUiArtifactsManifest)],
    });

    expect(registry.actions[0]).toMatchObject({
      pluginId: 'com.acme.client-action',
      identity: { pluginId: 'com.acme.client-action', localId: 'open-preview' },
      pluginRootPath: '/plugins/com.acme.client-action',
      generatedUiArtifactsManifest,
    });
  });

  it('normalizes plugin-only Actions without creating a human placement or confirmation', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.provider', {
      actions: [{
        id: 'refresh-provider-state',
        title: 'Refresh provider state',
        scopes: ['session'],
        surfaces: ['plugin'],
        execution: { target: 'daemon' },
        dangerLevel: 'writesRemote',
      }],
    })] });

    expect(registry.actions[0]?.definition).toMatchObject({
      surfaces: {
        plugin: true,
        ui: false,
        cli: false,
        mcp: false,
        agent: false,
      },
      contributionSurfaces: ['plugin'],
      dangerLevel: 'writesRemote',
    });
    expect(registry.actions[0]?.definition).not.toHaveProperty('placement');
    expect(registry.actions[0]?.definition).not.toHaveProperty('confirmation');
  });

  it('normalizes contributed Action input hints through the shared presentation descriptor', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.provider', {
      actions: [{
        id: 'configure',
        title: 'Configure provider',
        scopes: ['settings'],
        surfaces: ['ui', 'plugin'],
        execution: { target: 'daemon' },
        placementBindings: ['detailsPanel'],
        dangerLevel: 'safe',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            enabled: { type: 'boolean' },
            revision: { type: 'integer' },
          },
          required: ['revision'],
          additionalProperties: false,
        },
        inputHints: {
          title: { key: 'configure.title', fallback: 'Configure provider' },
          submitLabel: { key: 'configure.submit', fallback: 'Save provider' },
          fields: [{
            path: 'provider',
            title: { key: 'configure.provider', fallback: 'Provider' },
            placeholder: { key: 'configure.provider.placeholder', fallback: 'Choose a provider' },
            widget: 'select',
            options: [{ value: 'acme', label: { key: 'configure.provider.acme', fallback: 'Acme' } }],
          }, {
            path: 'enabled',
            title: { key: 'configure.enabled', fallback: 'Enabled' },
            widget: 'boolean',
          }],
        },
      }],
    })] });

    expect(registry.actions[0]?.definition.inputHints).toEqual({
      title: 'Configure provider',
      submitLabel: 'Save provider',
      fields: [{
        path: 'provider',
        title: 'Provider',
        placeholder: 'Choose a provider',
        widget: 'select',
        options: [{ value: 'acme', label: 'Acme' }],
      }, {
        path: 'enabled',
        title: 'Enabled',
        widget: 'boolean',
      }, { path: 'revision', title: 'Revision', widget: 'integer', required: true }],
    });
    const localized = PluginProjectedActionInputHintsV2Schema.parse(registry.actions[0]?.localizedPresentation?.inputHints);
    expect(localized.fields).toMatchObject([
      { path: 'provider', title: { key: 'configure.provider', fallback: 'Provider' },
        options: [{ value: 'acme', label: { key: 'configure.provider.acme', fallback: 'Acme' } }] },
      { path: 'enabled', title: { key: 'configure.enabled', fallback: 'Enabled' } },
      { path: 'revision', title: 'Revision', widget: 'integer', required: true },
    ]);
  });

  it('resolves foreign structured references against all loaded manifests', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.consumer', {
      browserTargets: [{ id: 'page', title: 'Page', url: 'https://example.com' }],
      browserActions: [{ id: 'runner', title: 'Runner', target: 'page', action: { pluginId: 'com.acme.missing', localId: 'run' } }],
    })] });
    expect(registry.browserActions).toEqual([]);
    expect(registry.browserTargets).toMatchObject([{ definition: { id: 'page' } }]);
    expect(registry.admittedGraph.diagnosticsByPluginId['com.acme.consumer']).toMatchObject([{
      code: 'plugin_contribution_skipped', details: { reason: 'plugin_manifest_dangling_reference' },
    }]);
  });

  it('retains an Agent with an unavailable optional account in the real catalog projection', () => {
    const plugin = bundledAgentWithConnectedAccounts('happier.agent.consumer', [{
      purpose: 'optional-account', service: { pluginId: 'com.acme.absent', localId: 'account' }, required: false,
    }]);
    const registry = buildPluginContributionRegistry({ loadedPlugins: [plugin] });
    expect(registry.agents).toMatchObject([{ definition: { id: 'consumer', connectedAccounts: [] } }]);
    const diagnostics = registry.admittedGraph.diagnosticsByPluginId[plugin.pluginId];
    expect(diagnostics?.map(diagnostic => PluginCompatibilityDiagnosticSchema.parse(diagnostic))).toEqual(diagnostics);
    expect(diagnostics).toMatchObject([{
      code: 'plugin_optional_reference_unavailable', contribution: { pluginId: plugin.pluginId, localId: 'consumer' },
      details: { reason: 'plugin_manifest_dangling_reference', path: ['contributes', 'agents', 0, 'connectedAccounts', 0, 'service'] },
    }]);
  });

  it('fails closed when bundled request-auth consumers omit their descriptor producers', () => {
    expect(buildPluginContributionRegistry({
      loadedPlugins: [bundledAgentWithConnectedAccounts('happier.agent.consumer', [{
        purpose: 'codex-model-request',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      }, {
        purpose: 'claude-model-request',
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
      }])],
    }).agents).toEqual([]);
  });

  it('does not let external producers satisfy references missing from the bundled universe', () => {
    const externalProducer = loaded('com.acme.external', {
      connectedAccountDescriptors: [{
        id: 'account',
        title: 'External account',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'Token',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
          }],
        },
      }],
    });
    const bundledConsumer = bundledAgentWithConnectedAccounts(
      'happier.agent.consumer',
      [{
        purpose: 'model-request',
        service: {
          pluginId: externalProducer.pluginId,
          localId: 'account',
        },
      }],
    );

    expect(buildPluginContributionRegistry({
      loadedPlugins: [externalProducer],
      referencePlugins: [bundledConsumer],
    }).agents).toEqual([]);
  });

  it('resolves an external host-access reference against bundled descriptors without projecting the bundled contribution', () => {
    const bundledProducer = {
      ...loaded('happier.agent.claude', {
        connectedAccountDescriptors: [{
          id: 'claude-subscription',
          title: 'Claude subscription',
          authentication: {
            defaultModeId: 'manual',
            modes: [{
              id: 'manual',
              kind: 'manual',
              outcomeReconciliation: 'none',
              fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
              }],
            }],
          },
        }],
      }),
      sourceSpec: {
        kind: 'bundled' as const,
        locator: '@happier-dev/plugin-agent-claude',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
      },
    };
    const externalConsumer = loaded(
      'com.acme.claude-consumer',
      {
        actions: [{
          id: 'run',
          title: 'Run',
          scopes: ['global'],
          surfaces: ['ui'],
          execution: { target: 'daemon' },
          placementBindings: ['commandPalette'],
          dangerLevel: 'safe',
          hostAccess: ['claude-account'],
        }],
      },
      undefined,
      {
        hostAccess: {
          required: [{
            id: 'claude-account',
            capability: 'connectedAccounts',
            reason: 'Use the selected Claude account',
            scope: {
              serviceRefs: [{
                pluginId: bundledProducer.pluginId,
                localId: 'claude-subscription',
              }],
              operations: ['use'],
            },
          }],
          optional: [],
        },
      },
    );

    const registry = buildPluginContributionRegistry({
      loadedPlugins: [externalConsumer],
      referencePlugins: [bundledProducer],
    });

    expect(registry.actions).toMatchObject([{
      pluginId: externalConsumer.pluginId,
      definition: {
        id: 'run',
        hostAccess: ['claude-account'],
      },
    }]);
    expect(registry.connectedAccountDescriptors).toEqual([]);
    expect(registry.semanticContributionsByFamily.get('connectedAccountDescriptors')).toBeUndefined();
  });

  it('resolves split MCP HostAccess references against bundled contributions without granting provenance privileges', () => {
    const bundledProducer = {
      ...loaded('happier.mcp.catalog', {
        mcp: {
          servers: [{ id: 'tools', title: 'Tools', kind: 'dynamic' }],
          discoverySources: [{ id: 'catalog', title: 'Catalog', loadedInHappierSessions: true }],
        },
      }),
      sourceSpec: {
        kind: 'bundled' as const,
        locator: '@happier-dev/plugin-mcp-catalog',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
      },
    };
    const externalConsumer = loaded(
      'com.acme.mcp-consumer',
      {
        actions: [{
          id: 'run',
          title: 'Run',
          scopes: ['global'],
          surfaces: ['ui'],
          execution: { target: 'daemon' },
          placementBindings: ['commandPalette'],
          dangerLevel: 'safe',
          hostAccess: ['mcp'],
        }],
      },
      undefined,
      {
        hostAccess: {
          required: [{
            id: 'mcp',
            capability: 'mcp',
            reason: 'Use selected MCP capabilities',
            scope: {
              serverRefs: [{ pluginId: bundledProducer.pluginId, localId: 'tools' }],
              discoverySourceRefs: [{ pluginId: bundledProducer.pluginId, localId: 'catalog' }],
              operations: ['listTools', 'discover'],
            },
          }],
          optional: [],
        },
      },
    );

    const registry = buildPluginContributionRegistry({
      loadedPlugins: [externalConsumer],
      referencePlugins: [bundledProducer],
    });

    expect(registry.actions).toMatchObject([{
      pluginId: externalConsumer.pluginId,
      definition: { id: 'run', hostAccess: ['mcp'] },
    }]);
    expect(registry.mcpServers).toEqual([]);
    expect(registry.mcpDiscoverySources).toEqual([]);
    expect(registry.semanticContributionsByFamily.get('mcp.servers')).toBeUndefined();
    expect(registry.semanticContributionsByFamily.get('mcp.discoverySources')).toBeUndefined();
  });

  it('rejects a connected-account reference when the validation universe only has the same local id in the wrong family', () => {
    const wrongFamilyProducer = loaded('happier.agent.claude', {
      actions: [{
        id: 'claude-subscription',
        title: 'Not an account descriptor',
        scopes: ['global'],
        surfaces: ['ui'],
        execution: { target: 'daemon' },
        placementBindings: ['commandPalette'],
        dangerLevel: 'safe',
      }],
    });
    const consumer = bundledAgentWithConnectedAccounts('com.acme.consumer', [{
      purpose: 'model-request',
      service: {
        pluginId: wrongFamilyProducer.pluginId,
        localId: 'claude-subscription',
      },
    }]);

    expect(buildPluginContributionRegistry({
      loadedPlugins: [consumer],
      referencePlugins: [wrongFamilyProducer],
    }).admittedGraph.diagnosticsByPluginId[consumer.pluginId]).toMatchObject([{
      code: 'plugin_contribution_skipped', details: { reason: 'plugin_manifest_wrong_family_reference' },
    }]);
  });

  it('keeps legacy request-auth purpose targets closed to external and unknown references', () => {
    expect(buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.external', {
        agents: bundledAgentWithConnectedAccounts('happier.agent.consumer', [{
          purpose: 'codex-model-request',
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        }]).manifest.contributes.agents,
      })],
    }).agents).toEqual([]);

    expect(buildPluginContributionRegistry({
      loadedPlugins: [bundledAgentWithConnectedAccounts('happier.agent.consumer', [{
        purpose: 'unknown-model-request',
        service: { pluginId: 'happier.agent.other', localId: 'missing' },
      }])],
    }).agents).toEqual([]);
  });

  it('preserves a valid foreign structured Action reference', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [
        loaded('com.acme.actions', {
          actions: [{
            id: 'run',
            title: 'Run',
            scopes: ['session'],
            surfaces: ['agent'],
            execution: { target: 'daemon' },
            placementBindings: ['secondary'],
            dangerLevel: 'safe',
          }],
        }),
        loaded('com.acme.browser', {
          browserTargets: [{ id: 'page', title: 'Page', url: 'https://example.com' }],
          browserActions: [{
            id: 'runner',
            title: 'Runner',
            target: 'page',
            action: { pluginId: 'com.acme.actions', localId: 'run' },
          }],
        }),
      ],
    });

    expect(registry.actions).toHaveLength(1);
    expect(registry.browserActions[0]?.definition).toMatchObject({
      action: { pluginId: 'com.acme.actions', localId: 'run' },
    });
  });

  it('preserves prompt assets with qualified identity and structured resource and agent references', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [
        loaded('com.acme.resources', {
          resources: [{ id: 'instructions', kind: 'prompt', path: 'instructions.md', contentType: 'text/markdown' }],
          agents: [{
            id: 'reviewer', title: 'Reviewer', runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          }],
        }),
        loaded('com.acme.prompts', {
          promptAssets: [{
            id: 'review-guidelines',
            kind: 'guidelines',
            resource: { pluginId: 'com.acme.resources', localId: 'instructions' },
            target: { kind: 'agent', agent: { pluginId: 'com.acme.resources', localId: 'reviewer' } },
            priority: 7,
          }],
        }),
      ],
    });

    expect(registry.promptAssets).toMatchObject([{
      pluginId: 'com.acme.prompts',
      identity: { pluginId: 'com.acme.prompts', localId: 'review-guidelines' },
      definition: {
        resource: { pluginId: 'com.acme.resources', localId: 'instructions' },
        target: { kind: 'agent', agent: { pluginId: 'com.acme.resources', localId: 'reviewer' } },
      },
    }]);
  });

  it('preserves the exact managed-dependency declaration instead of rebuilding a legacy installable descriptor', () => {
    const definition = {
      id: 'acme-cli',
      title: 'Acme CLI',
      sources: [{ kind: 'system' as const, executableNames: ['acme'] }],
      executable: 'acme',
    };
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.dependencies', { managedDependencies: [definition] })],
    });

    expect(registry.managedDependencies[0]?.definition).toEqual(definition);
    expect(registry.managedDependencies[0]?.definition).not.toHaveProperty('capabilityId');
  });

  it('preserves exact system-tool declarations for downstream host-access resolution', () => {
    const definition = { id: 'git', title: 'Git', executableNames: ['git'] };
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.tools', { systemTools: [definition] })],
    });

    expect(registry.systemTools[0]?.definition).toEqual(definition);
  });

  it('preserves data-only voice model packs with qualified identity', () => {
    const definition = {
      id: 'english-small',
      schemaVersion: 1 as const,
      executionHosts: ['daemon'] as const,
      manifest: {
        schemaVersion: 1 as const,
        kind: 'stt_sherpa' as const,
        model: 'english-small',
        version: '1.0.0',
        runtime: {
          family: 'sherpa_zipformer_streaming' as const,
          artifacts: {
            encoder: { type: 'file' as const, path: 'encoder.onnx' },
            decoder: { type: 'file' as const, path: 'decoder.onnx' },
            joiner: { type: 'file' as const, path: 'joiner.onnx' },
            tokens: { type: 'file' as const, path: 'tokens.txt' },
          },
          abiVersion: 1,
          minHostVersion: '1.0.0',
          platforms: ['darwin'] as const,
          architectures: ['arm64'] as const,
        },
        provenance: { source: 'https://models.example.test/english-small', publisher: 'Acme' },
        license: { id: 'Apache-2.0', title: 'Apache License 2.0', url: 'https://models.example.test/license', requiresAcceptance: false },
        files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((path, index) => ({
          path,
          url: `https://models.example.test/english-small/${path}`,
          sha256: String(index + 1).repeat(64),
          sizeBytes: 4,
        })),
      },
    };
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.models', { voiceModelPacks: [definition] })],
    });

    expect(registry.voiceModelPacks[0]).toMatchObject({
      pluginId: 'com.acme.models',
      identity: { pluginId: 'com.acme.models', localId: 'english-small' },
      definition,
    });
  });

  it('preserves executable Voice declarations with qualified identity', () => {
    const definition = {
      id: 'conversation', title: 'Conversation', kind: 'conversation' as const,
      roles: ['realtime_conversation', 'turn_control'] as const, platforms: ['web'] as const,
      capabilities: { turn: { cancelResponse: true, bargeIn: true } },
      execution: {
        kind: 'experimental_agent_session_realtime' as const,
        agent: 'codex',
        supportedRuntimeVersions: ['1.2.3'],
      },
      settings: {
        schemaVersion: 2 as const,
        fields: [],
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          title: 'Codex account',
          agent: 'codex',
          serviceIds: ['openai-codex'] as const,
        },
      },
      client: { artifactId: 'voice-runtime', exportName: 'activate' as const },
    };
    const generatedUiArtifactsManifest = PluginUiArtifactsManifestV2Schema.parse({
      version: 2 as const,
      entries: [{
        artifactId: 'voice-runtime',
        tier: 'reactNative' as const,
        entry: 'react-native/voice-runtime/entry.cjs.bundle',
        files: [{
          relativePath: 'react-native/voice-runtime/entry.cjs.bundle',
          digest: `sha256:${'2'.repeat(64)}`,
          byteSize: 1,
        }],
        digest: `sha256:${'1'.repeat(64)}`,
        builtWith: { bundler: 'esbuild' as const, version: '0.27.2' },
        executable: { exports: ['activate'] },
        hostUiApiRange: '^1.0.0',
      }],
    });
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.voice', { voiceProviders: [definition] }, generatedUiArtifactsManifest)],
    });

    expect(registry.voiceProviders[0]).toMatchObject({
      pluginId: 'com.acme.voice',
      identity: { pluginId: 'com.acme.voice', localId: 'conversation' },
      generatedUiArtifactsManifest,
      definition: {
        ...definition,
        execution: {
          kind: 'experimental_agent_session_realtime',
          agent: { pluginId: 'com.acme.voice', localId: 'codex' },
          supportedRuntimeVersions: ['1.2.3'],
        },
        settings: {
          ...definition.settings,
          connectedServicesBinding: {
            ...definition.settings.connectedServicesBinding,
            agent: { pluginId: 'com.acme.voice', localId: 'codex' },
          },
        },
      },
    });
  });

  it('rejects a Connected Services binding for a different Agent than the Voice execution declaration', () => {
    const definition = {
      id: 'conversation', title: 'Conversation', kind: 'conversation' as const,
      roles: ['realtime_conversation'] as const, platforms: ['web'] as const,
      capabilities: { turn: { cancelResponse: true, bargeIn: true } },
      execution: {
        kind: 'experimental_agent_session_realtime' as const,
        agent: 'codex',
        supportedRuntimeVersions: ['1.2.3'],
      },
      settings: {
        schemaVersion: 2 as const,
        fields: [],
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          title: 'Different Agent account',
          agent: 'other-agent',
          serviceIds: ['openai-codex'] as const,
        },
      },
      client: { artifactId: 'voice-runtime', exportName: 'activate' as const },
    };

    expect(() => buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.voice', { voiceProviders: [definition] })],
    })).toThrow('Voice Connected Services binding Agent must match its Agent-session realtime execution Agent');
  });

  it('preserves canonical nested UI views, renderers, and translations with qualified identities', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.ui', {
        resources: [{ id: 'copy-en', kind: 'asset', path: 'assets/i18n/en.json', contentType: 'application/json' }],
        ui: {
          views: [{
            id: 'panel',
            container: 'rightPane',
            target: { kind: 'session' },
            renderer: 'panel-renderer',
            title: 'Acme',
          }, {
            id: 'file-details',
            container: 'detailsTab',
            target: { kind: 'session' },
            renderer: 'panel-renderer',
            title: 'File',
          }],
          renderers: [{ id: 'panel-renderer', kind: 'declarative', root: { kind: 'text', text: 'Hello' } }],
          settingsGroups: [{ id: 'review', title: 'Review' }],
          settingsPages: [{
            id: 'review-settings',
            group: { kind: 'plugin', localId: 'review' },
            title: 'Review settings',
            renderer: 'panel-renderer',
          }],
          translations: [{ locale: 'en', resourceId: 'copy-en' }],
        },
        openableContentViewers: [{
          id: 'markdown',
          destination: 'file-details',
          contentClasses: ['text'],
          mimeTypes: ['text/markdown'],
          extensions: ['.md'],
        }],
      })],
    });

    expect(registry.uiViewsV2[0]).toMatchObject({
      identity: { pluginId: 'com.acme.ui', localId: 'panel' },
      definition: { id: 'panel', renderer: 'panel-renderer' },
    });
    expect(registry.uiRenderersV2[0]).toMatchObject({
      identity: { pluginId: 'com.acme.ui', localId: 'panel-renderer' },
    });
    expect(registry.uiSettingsGroupsV2[0]).toMatchObject({
      identity: { pluginId: 'com.acme.ui', localId: 'review' },
      definition: { id: 'review' },
    });
    expect(registry.uiSettingsPagesV2[0]).toMatchObject({
      identity: { pluginId: 'com.acme.ui', localId: 'review-settings' },
      definition: { id: 'review-settings', renderer: 'panel-renderer' },
    });
    expect(registry.uiTranslationsV2[0]).toMatchObject({
      localeIdentity: { pluginId: 'com.acme.ui', locale: 'en' },
      definition: { locale: 'en' },
    });
    expect(registry.uiTranslationsV2[0]).not.toHaveProperty('identity');
    expect(registry.openableContentViewers[0]).toMatchObject({
      identity: { pluginId: 'com.acme.ui', localId: 'markdown' },
      definition: {
        id: 'markdown',
        destination: 'file-details',
        contentClasses: ['text'],
        mimeTypes: ['text/markdown'],
        extensions: ['.md'],
      },
    });
  });

  it('rejects a multiple-instance details destination for an openable-content viewer before UI projection', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.viewer', {
        ui: {
          renderers: [{ id: 'viewer-renderer', kind: 'declarative', root: { kind: 'text', text: 'Viewer' } }],
          views: [{
            id: 'file-details',
            container: 'detailsTab',
            target: { kind: 'session' },
            renderer: 'viewer-renderer',
            instancePolicy: 'multiple',
          }],
        },
        openableContentViewers: [{
          id: 'markdown',
          destination: 'file-details',
          contentClasses: ['text'],
        }],
      })],
    });
    expect(registry.openableContentViewers).toEqual([]);
    expect(registry.uiViewsV2).toMatchObject([{ definition: { id: 'file-details' } }]);
    expect(registry.admittedGraph.diagnosticsByPluginId['com.acme.viewer']).toMatchObject([{
      code: 'plugin_contribution_skipped', details: { reason: 'plugin_manifest_invalid' },
    }]);
  });

  it('retains a session-scoped transcript Activity descriptor with its canonical plugin identity', () => {
    const pluginId = 'com.acme.activity';
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded(pluginId, {
        resources: [{
          id: 'live-activity',
          source: 'dynamic',
          kind: 'config',
          scope: 'session',
          contentType: 'application/vnd.happier.transcript-activity+json;v=1',
          maxBytes: 64 * 1024,
          hostAccess: ['account-storage'],
        }],
        transcriptActivities: [{
          id: 'delivery-status',
          resourceId: 'live-activity',
          actions: [],
        }],
      }, undefined, {
        hostAccess: {
          required: [{
            id: 'account-storage',
            capability: 'storage.account',
            reason: 'Read the current activity status.',
            scope: { enabled: true },
          }],
          optional: [],
        },
      })],
    });

    expect(registry.transcriptActivities).toMatchObject([{
      pluginId,
      identity: { pluginId, localId: 'delivery-status' },
      definition: {
        id: 'delivery-status',
        resourceId: 'live-activity',
        actions: [],
      },
    }]);
  });
});
