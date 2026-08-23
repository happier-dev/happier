import { describe, expect, it } from 'vitest';
import { PluginUiArtifactsManifestV1Schema } from '@happier-dev/protocol/plugins/ui';

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

  it('qualifies action presentation references and preserves exact declarations', () => {
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
        placementBindings: ['primary'],
        resultSchema,
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
      outputSchema: resultSchema,
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
            modulePath: './voiceClient',
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
          modulePath: './voiceClient',
          exportName: 'registerVoiceAction',
        },
        platforms: ['web', 'ios'],
      },
      surfaces: { voice: true, cli: false, ui: false },
      contributionSurfaces: ['voice'],
    });
  });

  it('retains generated Artifact custody on the exact client Action that declares it', () => {
    const generatedUiArtifactsManifest = PluginUiArtifactsManifestV1Schema.parse({
      version: 1 as const,
      entries: [{
        contributionId: 'action-client-artifact',
        tier: 'reactNative' as const,
        platform: 'web' as const,
        entry: 'react-native/action-client/index.js',
        files: [{
          relativePath: 'react-native/action-client/index.js',
          digest: `sha256:${'2'.repeat(64)}`,
          byteSize: 1,
        }],
        digest: `sha256:${'1'.repeat(64)}`,
        builtWith: { bundler: 'vite' as const, version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.2.0', reactNative: '0.83.4' },
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
              modulePath: './actionClient',
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
          },
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
      }],
    });
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
          discoverySources: [{ id: 'catalog', title: 'Catalog' }],
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
            execution: { target: 'daemon' },
            placementBindings: ['secondary'],
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
      client: { artifactId: 'voice-runtime', modulePath: './voiceRuntime', exportName: 'activate' as const },
    };
    const generatedUiArtifactsManifest = PluginUiArtifactsManifestV1Schema.parse({
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
      client: { artifactId: 'voice-runtime', modulePath: './voiceRuntime', exportName: 'activate' as const },
    };

    expect(() => buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.voice', { voiceProviders: [definition] })],
    })).toThrow('Voice Connected Services binding Agent must match its Agent-session realtime execution Agent');
  });

  it('preserves canonical nested UI views, renderers, and translations with qualified identities', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [loaded('com.acme.ui', {
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
          translations: [{ locale: 'en', messages: { title: 'Acme' } }],
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
    expect(() => buildPluginContributionRegistry({
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
    })).toThrow(/Openable-content viewer destinations must use singleton instance policy/u);
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
