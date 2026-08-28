import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PluginManifestV2Schema,
  type ParsedPluginManifestV2,
  type PluginManifestV2,
} from '../../index.js';
import { MAX_PLUGIN_COMPOSER_ATTACHMENTS_V1 } from '../contributions/composerAttachments.js';
import { PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1 } from '../ui/targetedContributions.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'com.acme.fixture',
    version: '1.0.0',
    displayName: 'Fixture',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    ...overrides,
  };
}

describe('plugin manifest v2 root contract', () => {
  it('admits at most the approved number of declared composer attachment types', () => {
    const composerAttachments = Array.from(
      { length: MAX_PLUGIN_COMPOSER_ATTACHMENTS_V1 },
      (_, index) => ({
        id: `attachment-${index}`,
        title: `Attachment ${index}`,
        icon: 'error',
        cardinality: 'many' as const,
        valueSchema: { type: 'object' },
      }),
    );

    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: { composerAttachments },
    })).success).toBe(true);
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: { composerAttachments: [...composerAttachments, {
        id: 'attachment-over-limit',
        title: 'Attachment over limit',
        icon: 'error',
        cardinality: 'many',
        valueSchema: { type: 'object' },
      }] },
    })).success).toBe(false);
  });

  it('defaults network.client private-network authority to false while preserving explicit intent', () => {
    const parsed = PluginManifestV2Schema.parse(manifest({
      hostAccess: {
        required: [{
          id: 'gateway',
          capability: 'network.client',
          reason: 'Maintain the gateway connection',
          scope: {
            targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
            transports: ['websocket'],
          },
        }, {
          id: 'loopback-gateway',
          capability: 'network.client',
          reason: 'Maintain the local gateway connection',
          scope: {
            targets: [{ kind: 'fixedOrigin', origin: 'http://127.0.0.1:4311' }],
            transports: ['websocket'],
            privateNetwork: true,
          },
        }],
        optional: [],
      },
    }));

    expect(parsed.hostAccess.required).toMatchObject([
      { id: 'gateway', scope: { privateNetwork: false } },
      { id: 'loopback-gateway', scope: { privateNetwork: true } },
    ]);
  });

  it('parses the current entrypoint and activation vocabulary with canonical defaults', () => {
    const authoredManifest = {
      schemaVersion: 2,
      id: 'com.acme.fixture',
      version: '1.0.0',
      displayName: 'Fixture',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: {
        daemon: './dist/plugin.js',
        development: './src/plugin.ts',
      },
      activation: {
        events: [{ kind: 'startup' }],
      },
    } satisfies PluginManifestV2;

    const parsed = PluginManifestV2Schema.parse(authoredManifest);

    expect(parsed).toMatchObject({
      entrypoints: authoredManifest.entrypoints,
      activation: authoredManifest.activation,
      hostAccess: { required: [], optional: [] },
    });
    expect(parsed.contributes).toBeDefined();
    expectTypeOf(parsed).toEqualTypeOf<ParsedPluginManifestV2>();
  });

  it('accepts globally namespaced plugin ids and rejects bare or non-canonical ids', () => {
    expect(PluginManifestV2Schema.safeParse(manifest({ id: 'happier.agent.codex' })).success).toBe(true);
    expect(PluginManifestV2Schema.safeParse(manifest({ id: 'codex' })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({ id: 'Happier.Agent.Codex' })).success).toBe(false);
  });

  it('accepts an absent or empty optional author-declared Happier engine gate', () => {
    const { engines: _engines, ...withoutEngines } = manifest();

    expect(PluginManifestV2Schema.safeParse(withoutEngines).success).toBe(true);
    expect(PluginManifestV2Schema.safeParse(manifest({ engines: {} })).success).toBe(true);
    expect(PluginManifestV2Schema.safeParse(manifest({ engines: { happier: '*' } })).success).toBe(false);
  });

  it('normalizes direct secret custody and keeps the secret namespace independent of Settings scope', () => {
    const parsed = PluginManifestV2Schema.parse(manifest({
      secrets: [
        { id: 'direct-account-default' },
        { id: 'direct-daemon', custody: 'daemon' },
      ],
      contributes: {
        settings: [{
          id: 'account-settings',
          title: 'Account settings',
          target: { kind: 'plugin' },
          scope: 'account',
          fields: [{
            id: 'reusable-non-secret',
            title: 'Reusable non-secret',
            schema: { type: 'string' },
          }, {
            id: 'account-secret',
            title: 'Account secret',
            schema: { type: 'string' },
            secret: true,
          }],
        }, {
          id: 'daemon-settings',
          title: 'Daemon settings',
          target: { kind: 'plugin' },
          scope: 'daemon',
          fields: [{
            id: 'reusable-non-secret',
            title: 'Reusable non-secret',
            schema: { type: 'string' },
          }, {
            id: 'daemon-secret',
            title: 'Daemon secret',
            schema: { type: 'string' },
            secret: { custody: 'daemon' },
          }],
        }],
      },
    }));

    expect(parsed.secrets).toEqual([
      { id: 'direct-account-default', custody: 'account' },
      { id: 'direct-daemon', custody: 'daemon' },
    ]);
    expect(parsed.contributes.settings.map((contribution) => contribution.scope)).toEqual([
      'account',
      'daemon',
    ]);

    const sameScopeDuplicate = manifest({
      contributes: {
        settings: [{
          id: 'one', title: 'One', target: { kind: 'plugin' }, scope: 'account',
          fields: [{ id: 'same-scope', title: 'One', schema: { type: 'string' } }],
        }, {
          id: 'two', title: 'Two', target: { kind: 'plugin' }, scope: 'account',
          fields: [{ id: 'same-scope', title: 'Two', schema: { type: 'string' } }],
        }],
      },
    });
    expect(PluginManifestV2Schema.safeParse(sameScopeDuplicate).success).toBe(false);

    const secretCollision = manifest({
      secrets: [{ id: 'credential' }],
      contributes: {
        settings: [{
          id: 'daemon-settings', title: 'Daemon', target: { kind: 'plugin' }, scope: 'daemon',
          fields: [{ id: 'credential', title: 'Credential label', schema: { type: 'string' } }],
        }],
      },
    });
    expect(PluginManifestV2Schema.safeParse(secretCollision).success).toBe(false);
  });

  it('rejects retired own-secret HostAccess requests', () => {
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          id: 'own-secret',
          capability: 'secrets',
          reason: 'Retired own-secret permission',
          scope: { secretIds: ['credential'], access: ['read'] },
        }],
        optional: [],
      },
    })).success).toBe(false);
  });

  it('rejects duplicate Voice Connected Account sources after manifest-relative qualification', () => {
    const rawGrant = {
      realm: 'daemon' as const,
      phase: 'speech' as const,
      request: {
        kind: 'httpHeaders' as const,
        origin: 'https://voice.example.test',
        headerNames: ['authorization'],
      },
    };
    const voiceManifest = (secondRawGrant: typeof rawGrant | Readonly<{
      realm: 'daemon';
      phase: 'speech';
      request: Readonly<{ kind: 'environment'; keys: readonly string[] }>;
    }>) => manifest({
      contributes: {
        voiceProviders: [{
          id: 'speech',
          title: 'Speech',
          kind: 'speech',
          roles: ['conversation_tts'],
          platforms: ['web'],
          credentials: {
            slot: { id: 'api_key', purpose: 'voice.speech', title: 'API key' },
            requirement: { kind: 'always' },
            sources: [{
              kind: 'connectedAccount', service: 'oauth', rawGrants: [rawGrant],
            }, {
              kind: 'connectedAccount',
              service: { pluginId: 'com.acme.fixture', localId: 'oauth' },
              rawGrants: [secondRawGrant],
            }],
          },
        }],
      },
    });

    expect(PluginManifestV2Schema.safeParse(voiceManifest(rawGrant)).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(voiceManifest({
      realm: 'daemon',
      phase: 'speech',
      request: { kind: 'environment', keys: ['VOICE_TOKEN'] },
    })).success).toBe(false);
  });

  it.each([
    ['uses', { uses: ['agents'] }],
    ['declares', { declares: { capabilities: [] } }],
    ['permissions', { permissions: { required: [] } }],
    ['source', { source: { kind: 'path', path: '/tmp/plugin' } }],
    ['activationEvents', { activationEvents: ['startup'] }],
    ['marketplace', { marketplace: { featured: true } }],
    ['targets', { targets: { daemon: './dist/plugin.js' } }],
    ['capabilities', { capabilities: [] }],
    ['contributions', { contributions: [] }],
  ])('rejects the retired root owner %s', (_name, retiredOwner) => {
    expect(PluginManifestV2Schema.safeParse(manifest(retiredOwner)).success).toBe(false);
  });

  it.each([
    ['main', { main: './dist/plugin.js' }],
    ['dev', { dev: './src/plugin.ts' }],
  ])('rejects the retired entrypoint %s', (_name, entrypoints) => {
    expect(PluginManifestV2Schema.safeParse(manifest({ entrypoints })).success).toBe(false);
  });

  it('rejects malformed current activation events and unknown root fields', () => {
    expect(PluginManifestV2Schema.safeParse(manifest({
      activation: { events: ['startup'] },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      futureBehavior: true,
    })).success).toBe(false);
  });

  it.each([
    ['Conversation Channels descriptor registry', 'conversationChannels'],
    ['legacy Channel bridge registry', 'channelBridges'],
    ['generic extension registry', 'extensions'],
    ['generic feature-local store', 'featureStores'],
    ['Event source supervisor registry', 'durableSources'],
    ['Event Automations registry', 'eventAutomations'],
  ])('rejects a retired feature-owned %s contribution family', (_label, family) => {
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: { [family]: [] },
    })).success).toBe(false);
  });

  it('accepts catalog-backed hook registrations and rejects unknown hook ids', () => {
    const hook = {
      id: 'before-agent-request',
      on: 'agent.request.before',
      category: 'decision',
      scope: 'agent',
      executionKind: 'decide',
    };

    const parsed = PluginManifestV2Schema.parse(manifest({
      hostAccess: {
        required: [{
          id: 'account',
          capability: 'connectedAccounts',
          reason: 'Use a selected account',
          scope: {
            serviceRefs: [{ pluginId: 'acme.accounts', localId: 'primary' }],
            operations: ['use'],
          },
        }],
        optional: [],
      },
      contributes: { hooks: [{ ...hook, hostAccess: ['account'] }] },
    }));
    expect(parsed.contributes.hooks).toEqual([{ ...hook, hostAccess: ['account'], hookApiVersion: 1 }]);
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        hooks: [{ ...hook, on: 'acme.custom.before' }],
      },
    })).success).toBe(false);
  });

  it('requires explicit use authority for bounded Connected Account materialization kinds', () => {
    const hostAccessRequest = {
      id: 'account',
      capability: 'connectedAccounts' as const,
      reason: 'Use a selected account',
      scope: {
        serviceRefs: [{ pluginId: 'acme.accounts', localId: 'primary' }],
        operations: ['use' as const],
        materializationKinds: ['files' as const, 'environment' as const],
      },
    };

    expect(PluginManifestV2Schema.parse(manifest({
      hostAccess: { required: [hostAccessRequest], optional: [] },
    })).hostAccess.required[0]).toEqual(hostAccessRequest);
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          ...hostAccessRequest,
          scope: {
            ...hostAccessRequest.scope,
            operations: ['select'],
          },
        }],
        optional: [],
      },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          ...hostAccessRequest,
          scope: {
            ...hostAccessRequest.scope,
            materializationKinds: [],
          },
        }],
        optional: [],
      },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          ...hostAccessRequest,
          scope: {
            ...hostAccessRequest.scope,
            materializationKinds: ['files', 'files'],
          },
        }],
        optional: [],
      },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          ...hostAccessRequest,
          scope: {
            ...hostAccessRequest.scope,
            materializationKinds: ['rawSecret'],
          },
        }],
        optional: [],
      },
    })).success).toBe(false);

    const inspectionOnly = {
      ...hostAccessRequest,
      scope: {
        serviceRefs: hostAccessRequest.scope.serviceRefs,
        operations: ['use' as const],
      },
    };
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: { required: [inspectionOnly], optional: [] },
    })).success).toBe(true);
  });

  it('accepts current request interceptors without promoting generic HostAccess', () => {
    const interceptor = {
      id: 'api-egress',
      origins: ['https://api.example.test'],
      methods: ['GET'],
      priority: 20,
    };

    const parsed = PluginManifestV2Schema.parse(manifest({
      contributes: { requestInterceptors: [interceptor] },
    }));
    expect(parsed.contributes.requestInterceptors).toEqual([interceptor]);

    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          id: 'intercept-api',
          capability: 'network.intercept',
          reason: 'Apply the declared request policy to the API.',
          scope: { origins: ['https://api.example.test'] },
        }],
        optional: [],
      },
    })).success).toBe(false);

    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          id: 'intercept-api',
          capability: 'network.intercept',
          reason: 'Apply the declared request policy to the API.',
          scope: { origins: ['https://api.example.test'], methods: ['GET'] },
        }],
        optional: [],
      },
    })).success).toBe(false);

    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        requestInterceptors: [{
          id: 'retired-shape',
          order: 20,
          targets: [{ scope: 'plugin-fetch' }],
        }],
      },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        requestInterceptors: [{
          ...interceptor,
          origins: ['https://api.example.test/path'],
        }],
      },
    })).success).toBe(false);
  });

  it('keeps MCP server and discovery-source HostAccess references operation-specific', () => {
    const mcpRequest = (scope: Record<string, unknown>) => manifest({
      hostAccess: {
        required: [{
          id: 'mcp',
          capability: 'mcp',
          reason: 'Use selected MCP capabilities',
          scope,
        }],
        optional: [],
      },
    });

    expect(PluginManifestV2Schema.parse(mcpRequest({
      serverRefs: ['tools'],
      operations: ['listTools', 'callTools'],
    })).hostAccess.required[0]).toMatchObject({
      scope: {
        serverRefs: ['tools'],
        discoverySourceRefs: [],
        operations: ['listTools', 'callTools'],
      },
    });
    expect(PluginManifestV2Schema.parse(mcpRequest({
      discoverySourceRefs: ['catalog'],
      operations: ['discover'],
    })).hostAccess.required[0]).toMatchObject({
      scope: {
        serverRefs: [],
        discoverySourceRefs: ['catalog'],
        operations: ['discover'],
      },
    });
    expect(PluginManifestV2Schema.safeParse(mcpRequest({
      serverRefs: ['tools'],
      discoverySourceRefs: ['catalog'],
      operations: ['listTools', 'discover'],
    })).success).toBe(true);

    expect(PluginManifestV2Schema.safeParse(mcpRequest({
      discoverySourceRefs: ['catalog'],
      operations: ['listTools'],
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(mcpRequest({
      discoveryProviderRefs: ['catalog'],
      operations: ['discover'],
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(mcpRequest({
      serverRefs: ['tools'],
      operations: ['discover'],
    })).success).toBe(false);

    for (const scope of [
      { serverRefs: ['tools', 'tools'], operations: ['listTools'] },
      { discoverySourceRefs: ['catalog', 'catalog'], operations: ['discover'] },
    ]) {
      expect(PluginManifestV2Schema.safeParse(mcpRequest(scope)).success).toBe(false);
    }
  });

  it('rejects provider-shaped keys on a current Agent contribution', () => {
    const agent = {
      id: 'fixture-agent',
      title: 'Fixture Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
    };

    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: { agents: [agent] },
    })).success).toBe(true);

    for (const providerKey of ['agentId', 'providerAgentId', 'providerCliRuntime']) {
      expect(PluginManifestV2Schema.safeParse(manifest({
        contributes: {
          agents: [{ ...agent, [providerKey]: 'provider-owned' }],
        },
      })).success, providerKey).toBe(false);
    }
  });

  it('rejects host-only packaged runtime binaries in manifest MCP stdio declarations', () => {
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        mcp: {
          servers: [{
            id: 'fixture-mcp',
            title: 'Fixture MCP',
            kind: 'static',
            transport: {
              kind: 'stdio',
              executable: {
                kind: 'packaged-runtime-binary',
                directorySegments: ['tools', 'unpacked'],
                executableBaseName: 'happier-cliproxyapi-managed',
              },
            },
          }],
        },
      },
    })).success).toBe(false);
  });

  it('keeps targeted contribution envelopes cold-normalizable when their target is absent', () => {
    const parsed = PluginManifestV2Schema.parse(manifest({
      contributes: {
        pluginContributionPoints: [{
          id: 'providers',
          maxContributionsPerContributor: 1,
          protocols: [{
            id: 'happier.channels/providers',
            version: 1,
            operations: {
              connectionTest: {
                required: true,
                input: { kind: 'contributorDefined' },
                resultSchema: { type: 'object' },
                action: { surface: 'plugin', dangerLevel: 'safe' },
              },
            },
          }],
        }],
        targetedPluginContributions: [{
          id: 'telegram-provider',
          target: { pluginId: 'happier.channels', pointId: 'providers' },
          protocol: { id: 'happier.channels/providers', version: 1 },
          operations: { connectionTest: 'arbitrary-setup-action' },
        }],
      },
    }));

    expect(parsed.contributes.pluginContributionPoints).toHaveLength(1);
    expect(parsed.contributes.targetedPluginContributions).toEqual([{
      id: 'telegram-provider',
      target: { pluginId: 'happier.channels', pointId: 'providers' },
      protocol: { id: 'happier.channels/providers', version: 1 },
      operations: { connectionTest: 'arbitrary-setup-action' },
    }]);
  });

  it('does not impose an invented aggregate byte ceiling on targeted protocol schemas', () => {
    const parsed = PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        pluginContributionPoints: [{
          id: 'providers',
          protocols: [{
            id: 'happier.channels/providers',
            version: 1,
            operations: {
              connectionTest: {
                required: true,
                input: { kind: 'contributorDefined' },
                resultSchema: {
                  type: 'object',
                  description: 'x'.repeat(70 * 1024),
                },
                action: { surface: 'plugin', dangerLevel: 'safe' },
              },
            },
          }],
        }],
      },
    }));

    expect(parsed.success).toBe(true);
  });

  it('admits exactly the Protocol-owned number of target protocol epochs per point', () => {
    const protocol = (version: number) => ({
      id: 'happier.channels/providers',
      version,
      operations: {
        connectionTest: {
          required: true,
          input: { kind: 'contributorDefined' },
          resultSchema: { type: 'object' },
          action: { surface: 'plugin', dangerLevel: 'safe' },
        },
      },
    });
    const epochs = Array.from(
      { length: PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1 },
      (_, index) => protocol(index + 1),
    );
    const point = { id: 'providers', protocols: epochs };

    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: { pluginContributionPoints: [point] },
    })).success).toBe(true);
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        pluginContributionPoints: [{
          ...point,
          protocols: [...epochs, protocol(PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1 + 1)],
        }],
      },
    })).success).toBe(false);
  });

  it('carries target-owned descriptors and renderer surface bindings without creating a renderer family', () => {
    const parsed = PluginManifestV2Schema.parse(manifest({
      contributes: {
        pluginContributionPoints: [{
          id: 'sources',
          protocols: [{
            id: 'triage-sources',
            version: 1,
            descriptor: {
              type: 'object',
              properties: { title: { type: 'string' } },
              required: ['title'],
              additionalProperties: false,
            },
            operations: {
              inspect: {
                required: false,
                input: { kind: 'contributorDefined' },
                resultSchema: { type: 'object' },
                action: { surface: 'plugin', dangerLevel: 'safe' },
              },
            },
            surfaces: {
              detail: {
                required: true,
                inputSchema: { type: 'object' },
                presentation: 'content',
              },
            },
          }],
        }],
        targetedPluginContributions: [{
          id: 'github-source',
          target: { pluginId: 'happier.triage', pointId: 'sources' },
          protocol: { id: 'triage-sources', version: 1 },
          descriptor: { title: 'GitHub' },
          operations: { inspect: 'inspect-source' },
          surfaces: {
            detail: {
              renderer: 'github-detail',
              fallbackRenderers: ['github-detail-fallback'],
            },
          },
        }],
      },
    }));

    expect(parsed.contributes.pluginContributionPoints[0]?.protocols[0]).toMatchObject({
      descriptor: { type: 'object' },
      surfaces: {
        detail: {
          required: true,
          presentation: 'content',
        },
      },
    });
    expect(parsed.contributes.targetedPluginContributions[0]).toMatchObject({
      descriptor: { title: 'GitHub' },
      surfaces: {
        detail: {
          renderer: 'github-detail',
          fallbackRenderers: ['github-detail-fallback'],
        },
      },
    });
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        targetedPluginContributions: [{
          id: 'duplicate-fallback',
          target: { pluginId: 'happier.triage', pointId: 'sources' },
          protocol: { id: 'triage-sources', version: 1 },
          operations: { inspect: 'inspect-source' },
          surfaces: {
            detail: {
              renderer: 'github-detail',
              fallbackRenderers: ['github-detail'],
            },
          },
        }],
      },
    })).success).toBe(false);
  });

  it('admits a surface-only point and contribution but rejects an empty role family', () => {
    const surfaceOnly = manifest({
      contributes: {
        pluginContributionPoints: [{
          id: 'details',
          protocols: [{
            id: 'triage-details',
            version: 1,
            operations: {},
            surfaces: {
              detail: {
                required: true,
                inputSchema: { type: 'object' },
                presentation: 'content',
              },
            },
          }],
        }],
        targetedPluginContributions: [{
          id: 'github-detail',
          target: { pluginId: 'happier.triage', pointId: 'details' },
          protocol: { id: 'triage-details', version: 1 },
          operations: {},
          surfaces: { detail: { renderer: 'github-detail' } },
        }],
      },
    });

    expect(PluginManifestV2Schema.safeParse(surfaceOnly).success).toBe(true);
    expect(PluginManifestV2Schema.safeParse({
      ...surfaceOnly,
      contributes: {
        ...surfaceOnly.contributes,
        pluginContributionPoints: [{
          ...surfaceOnly.contributes.pluginContributionPoints[0],
          protocols: [{
            ...surfaceOnly.contributes.pluginContributionPoints[0]!.protocols[0],
            surfaces: undefined,
          }],
        }],
      },
    }).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse({
      ...surfaceOnly,
      contributes: {
        ...surfaceOnly.contributes,
        targetedPluginContributions: [{
          ...surfaceOnly.contributes.targetedPluginContributions[0],
          surfaces: undefined,
        }],
      },
    }).success).toBe(false);
  });
});
