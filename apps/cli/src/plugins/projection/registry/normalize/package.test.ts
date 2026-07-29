import { describe, expect, it } from 'vitest';

import { buildPluginContributionRegistry } from './package';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';

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
    manifestDigest: 'digest',
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

function bundledAgentWithConnectedAccounts(
  pluginId: string,
  connectedAccounts: readonly Readonly<{
    purpose: string;
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
  it('projects every declared catalog family through the authoritative semantic inventory', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.locale', {
        ui: {
          translations: [{ locale: 'en-US', messages: { greeting: 'Hello' } }],
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

  it('qualifies action presentation references and preserves exact declarations', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.plugin', {
      actions: [{
        id: 'run',
        title: 'Run',
        scopes: ['session'],
        surfaces: ['cli'],
        placement: 'primary',
        dangerLevel: 'writesRemote',
        confirmation: {
          title: { key: 'actions.run.title', fallback: 'Run remotely?' },
          confirmLabel: { key: 'actions.run.confirm', fallback: 'Run' },
        },
      }],
      tools: [{ id: 'runner', name: 'runner', title: 'Runner', action: 'run' }],
      commands: [{ id: 'run-command', title: 'Run', path: ['run'], action: 'run' }],
    })] });
    expect(registry.tools[0]?.definition.actionId).toBe('com.acme.plugin/run');
    expect(registry.commands[0]?.definition.actionId).toBe('com.acme.plugin/run');
    expect(registry.actions[0]?.definition).toMatchObject({
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'actions.run.title', fallback: 'Run remotely?' },
        confirmLabel: { key: 'actions.run.confirm', fallback: 'Run' },
      },
    });
  });

  it('preserves UI as an explicit action surface without aliasing CLI', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.plugin', {
      actions: [{ id: 'open', title: 'Open', scopes: ['session'], surfaces: ['ui'], placement: 'detailsPanel', dangerLevel: 'safe' }],
    })] });

    expect(registry.actions[0]?.definition.surfaces).toMatchObject({
      ui: true,
      cli: false,
      mcp: false,
      agent: false,
    });
    expect(registry.actions[0]?.definition.contributionSurfaces).toEqual(['ui']);
  });

  it('resolves foreign structured references against all loaded manifests', () => {
    expect(() => buildPluginContributionRegistry({ loadedPlugins: [loaded('com.acme.consumer', {
      tools: [{ id: 'runner', name: 'runner', title: 'Runner', action: { pluginId: 'com.acme.missing', localId: 'run' } }],
    })] })).toThrow(/Invalid cross-plugin contribution reference/);
  });

  it('fails closed when bundled request-auth consumers omit their descriptor producers', () => {
    expect(() => buildPluginContributionRegistry({
      loadedPlugins: [bundledAgentWithConnectedAccounts('happier.agent.consumer', [{
        purpose: 'codex-model-request',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      }, {
        purpose: 'claude-model-request',
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
      }])],
    })).toThrow(/Invalid cross-plugin contribution reference/);
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

    expect(() => buildPluginContributionRegistry({
      loadedPlugins: [externalProducer],
      referencePlugins: [bundledConsumer],
    })).toThrow(
      /happier\.agent\.consumer references missing connectedAccountDescriptors contribution com\.acme\.external\/account/u,
    );
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
          placement: 'commandPalette',
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

  it('rejects a connected-account reference when the validation universe only has the same local id in the wrong family', () => {
    const wrongFamilyProducer = loaded('happier.agent.claude', {
      actions: [{
        id: 'claude-subscription',
        title: 'Not an account descriptor',
        scopes: ['global'],
        surfaces: ['ui'],
        placement: 'commandPalette',
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

    expect(() => buildPluginContributionRegistry({
      loadedPlugins: [consumer],
      referencePlugins: [wrongFamilyProducer],
    })).toThrow(
      /references missing connectedAccountDescriptors contribution happier\.agent\.claude\/claude-subscription/u,
    );
  });

  it('keeps legacy request-auth purpose targets closed to external and unknown references', () => {
    expect(() => buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.external', {
        agents: bundledAgentWithConnectedAccounts('happier.agent.consumer', [{
          purpose: 'codex-model-request',
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        }]).manifest.contributes.agents,
      })],
    })).toThrow(/Invalid cross-plugin contribution reference/);

    expect(() => buildPluginContributionRegistry({
      loadedPlugins: [bundledAgentWithConnectedAccounts('happier.agent.consumer', [{
        purpose: 'unknown-model-request',
        service: { pluginId: 'happier.agent.other', localId: 'missing' },
      }])],
    })).toThrow(/Invalid cross-plugin contribution reference/);
  });

  it('preserves a valid foreign structured reference and qualifies its resolved action identity', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [
        loaded('com.acme.actions', {
          actions: [{
            id: 'run',
            title: 'Run',
            scopes: ['session'],
            surfaces: ['agent'],
            placement: 'secondary',
            dangerLevel: 'safe',
          }],
        }),
        loaded('com.acme.tools', {
          tools: [{
            id: 'runner',
            name: 'runner',
            title: 'Runner',
            action: { pluginId: 'com.acme.actions', localId: 'run' },
          }],
        }),
      ],
    });

    expect(registry.actions).toHaveLength(1);
    expect(registry.tools[0]?.definition).toMatchObject({
      action: { pluginId: 'com.acme.actions', localId: 'run' },
      actionId: 'com.acme.actions/run',
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
      capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: true, bargeIn: true } },
      execution: { kind: 'experimental_agent_session_realtime' as const, agent: 'codex' },
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
      client: { artifactId: 'voice-runtime', modulePath: './voiceRuntime', exportName: 'activate' as const },
    };
    const generatedUiArtifactsManifest = {
      version: 1 as const,
      entries: [{
        contributionId: 'voice-runtime',
        tier: 'reactNative' as const,
        platform: 'web' as const,
        entry: 'react-native/voice-runtime/index.js',
        files: [{
          relativePath: 'react-native/voice-runtime/index.js',
          digest: `sha256:${'2'.repeat(64)}`,
          byteSize: 1,
        }],
        digest: `sha256:${'1'.repeat(64)}`,
        builtWith: { bundler: 'vite' as const, version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.2.0', reactNative: '0.83.4' },
      }],
    };
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
        },
      },
    });
  });

  it('preserves canonical nested UI views, renderers, and translations with qualified identities', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.ui', {
        ui: {
          views: [{ id: 'panel', placement: 'app.sidePanel', renderer: 'panel-renderer', title: 'Acme' }],
          renderers: [{ id: 'panel-renderer', kind: 'declarative', root: { kind: 'text', text: 'Hello' } }],
          translations: [{ locale: 'en', messages: { title: 'Acme' } }],
        },
      })],
    });

    expect(registry.uiViewsV2[0]).toMatchObject({
      identity: { pluginId: 'com.acme.ui', localId: 'panel' },
      definition: { id: 'panel', renderer: 'panel-renderer' },
    });
    expect(registry.uiRenderersV2[0]).toMatchObject({
      identity: { pluginId: 'com.acme.ui', localId: 'panel-renderer' },
    });
    expect(registry.uiTranslationsV2[0]).toMatchObject({
      localeIdentity: { pluginId: 'com.acme.ui', locale: 'en' },
      definition: { locale: 'en' },
    });
    expect(registry.uiTranslationsV2[0]).not.toHaveProperty('identity');
  });
});
