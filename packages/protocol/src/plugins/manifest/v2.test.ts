import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import * as protocol from '../../index.js';
import type { ParsedPluginManifestV2, PluginManifestV2 } from '../../index.js';

function readSchemaExport(name: string): z.ZodTypeAny | undefined {
  const value = (protocol as Record<string, unknown>)[name];
  return value && typeof value === 'object' && 'safeParse' in value
    ? value as z.ZodTypeAny
    : undefined;
}

describe('plugin manifest v2 contracts', () => {
  it('requires globally namespaced plugin owner ids while accepting first-party owner ids', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      version: '1.0.0',
      displayName: 'Owner Id Test',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: [] },
      contributes: {},
      capabilities: { permissions: [] },
    };
    const firstPartyAgentPluginId = 'happier.agent.codex';
    const firstPartyScmPluginId = 'happier.scm.hosting.github';

    expect(manifestSchema!.parse({
      ...baseManifest,
      id: firstPartyAgentPluginId,
    }).id).toBe(firstPartyAgentPluginId);
    expect(manifestSchema!.parse({
      ...baseManifest,
      id: firstPartyScmPluginId,
    }).id).toBe(firstPartyScmPluginId);

    for (const id of ['codex', 'claude', 'opencode', 'scm-github', 'Acme.Plugin']) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        id,
      }).success, id).toBe(false);
    }
  });

  it('accepts nested contributes and capabilities while rejecting stale flat keys', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.plugin',
      version: '1.0.0',
      displayName: 'Acme Plugin',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['actions', 'commands'],
      },
      contributes: {
        actions: [
          {
            id: 'acme.plugin.refresh',
            title: 'Refresh Acme',
            scopes: ['settings'],
            surfaces: ['settings'],
            placement: 'primary',
            dangerLevel: 'safe',
            handler: {
              target: 'daemon',
              exportName: 'refreshAcme',
            },
          },
        ],
        commands: [
          {
            id: 'acme.plugin.reload',
            command: 'acme reload',
            handler: {
              target: 'daemon',
              exportName: 'reloadAcme',
            },
          },
        ],
      },
      capabilities: {
        permissions: [
          {
            capability: 'actions.execute',
            reason: 'Run the plugin action when selected by the user',
          },
        ],
      },
    });

    expect(parsed.contributes.actions).toHaveLength(1);
    expect(parsed.contributes.commands).toHaveLength(1);
    expect(parsed.capabilities.permissions).toHaveLength(1);

    const staleFlatManifest = {
      schemaVersion: 2,
      id: 'acme.plugin',
      version: '1.0.0',
      displayName: 'Acme Plugin',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['actions'] },
      contributes: {},
      capabilities: {},
    } as Record<string, unknown>;
    staleFlatManifest.contributions = [];
    expect(manifestSchema!.safeParse(staleFlatManifest).success).toBe(false);

    const stalePermissionManifest = {
      schemaVersion: 2,
      id: 'acme.plugin',
      version: '1.0.0',
      displayName: 'Acme Plugin',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['actions'] },
      contributes: {},
      capabilities: {},
    } as Record<string, unknown>;
    stalePermissionManifest.permissions = [];
    expect(manifestSchema!.safeParse(stalePermissionManifest).success).toBe(false);
  });

  it('accepts final hierarchical permission names and optional runtime grants while rejecting stale event names', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.permissions',
      version: '1.0.0',
      displayName: 'Acme Permissions',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['terminalHost'] },
      contributes: {},
    };

    const parsed = manifestSchema!.parse({
      ...baseManifest,
      capabilities: {
        permissions: [
          { capability: 'events.runtime.subscribe' },
          { capability: 'events.lifecycle.subscribe' },
          { capability: 'events.session.subscribe' },
          { capability: 'events.plugin.subscribe', scope: 'acme.observed' },
          { capability: 'network' },
          { capability: 'network.intercept' },
          { capability: 'reviews.comments.write.direct' },
          { capability: 'terminal.host.control' },
        ],
        optionalPermissions: [
          { capability: 'secrets.read', reason: 'Read user-selected credentials at runtime' },
          { capability: 'storage.synced' },
        ],
      },
    });

    expect(parsed.capabilities.permissions.map((permission) => permission.capability)).toEqual([
      'events.runtime.subscribe',
      'events.lifecycle.subscribe',
      'events.session.subscribe',
      'events.plugin.subscribe',
      'network',
      'network.intercept',
      'reviews.comments.write.direct',
      'terminal.host.control',
    ]);
    expect(parsed.capabilities.optionalPermissions.map((permission) => permission.capability)).toEqual([
      'secrets.read',
      'storage.synced',
    ]);

    for (const staleCapability of [
      'events.subscribe',
      'runtimeEvents.subscribe',
      'runtime.subscribe',
      'lifecycle.subscribe',
      'session.subscribe',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        capabilities: {
          permissions: [{ capability: staleCapability }],
        },
      }).success, staleCapability).toBe(false);
    }
  });

  it('accepts system-tool contributions with schema defaults and rejects unknown tool fields', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.system-tools',
      version: '1.0.0',
      displayName: 'Acme System Tools',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: [] },
      capabilities: { permissions: [] },
    };

    const parsed = manifestSchema!.parse({
      ...baseManifest,
      contributes: {
        systemTools: [
          {
            toolId: 'acme.audit',
            displayName: 'Acme Audit',
            lookupNames: ['acme-audit'],
            source: 'system',
          },
        ],
      },
    });

    expect(parsed.contributes.systemTools).toEqual([
      {
        toolId: 'acme.audit',
        displayName: 'Acme Audit',
        lookupNames: ['acme-audit'],
        defaultArgs: [],
        source: 'system',
      },
    ]);
    expect(manifestSchema!.safeParse({
      ...baseManifest,
      contributes: {
        systemTools: [
          {
            toolId: 'acme.audit',
            displayName: 'Acme Audit',
            command: 'acme-audit',
          },
        ],
      },
    }).success).toBe(false);
  });

  it('types optional runtime permission grants as authoring-optional and parse-defaulted', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const authoredManifest = {
      schemaVersion: 2,
      id: 'acme.optional-permissions',
      version: '1.0.0',
      displayName: 'Acme Optional Permissions',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: [] },
      capabilities: {
        permissions: [],
      },
      contributes: {},
    } satisfies PluginManifestV2;

    const parsed = manifestSchema!.parse(authoredManifest) as ParsedPluginManifestV2;

    expect(parsed.capabilities.optionalPermissions).toEqual([]);
    expectTypeOf(parsed.capabilities.optionalPermissions).toEqualTypeOf<ParsedPluginManifestV2['capabilities']['optionalPermissions']>();
  });

  it('accepts manifest-declared events with local slash ids and rejects stale event ids', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.events',
      version: '1.0.0',
      displayName: 'Acme Events',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: [] },
      capabilities: { permissions: [] },
    };

    const parsed = manifestSchema!.parse({
      ...baseManifest,
      contributes: {
        events: [
          {
            id: 'checkpoint/created',
            payloadSchema: {
              type: 'object',
              properties: {
                checkpointId: { type: 'string' },
              },
              required: ['checkpointId'],
            },
            description: 'Emitted when Acme creates a checkpoint',
          },
        ],
      },
    });

    expect(parsed.contributes.events).toEqual([
      {
        id: 'checkpoint/created',
        payloadSchema: {
          type: 'object',
          properties: {
            checkpointId: { type: 'string' },
          },
          required: ['checkpointId'],
        },
        description: 'Emitted when Acme creates a checkpoint',
        deprecated: false,
      },
    ]);

    for (const staleEventId of [
      'checkpoint.created',
      'acme.events.checkpoint-created',
      'acme.events/checkpoint-created',
      '@happier/runtime/reload',
      '/checkpoint',
      'checkpoint/',
      'checkpoint//created',
      'checkpoint/Created',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          events: [{ id: staleEventId }],
        },
      }).success, staleEventId).toBe(false);
    }
  });

  it('accepts only catalog-backed public hook ids in manifest declarations', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.hooks',
      version: '1.0.0',
      displayName: 'Acme Hooks',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['hooks'] },
      capabilities: { permissions: [{ capability: 'hooks.register' }] },
    };
    const providerResponseHook = {
      id: 'provider.response.after',
      category: 'lifecycle',
      scope: 'provider',
      executionKind: 'observe',
      handler: { target: 'plugin', exportName: 'onProviderResponse' },
    };
    const parsed = manifestSchema!.parse({
      ...baseManifest,
      contributes: {
        hooks: [
          providerResponseHook,
          {
            id: 'subagent.start',
            category: 'lifecycle',
            scope: 'session',
            executionKind: 'observe',
            handler: { target: 'plugin', exportName: 'onSubagentStart' },
          },
        ],
      },
    });

    expect(parsed.contributes.hooks.map((hook) => hook.id)).toEqual([
      'provider.response.after',
      'subagent.start',
    ]);

    for (const id of [
      'connectedServices.materialization.githubScmHostingToken',
      'connectedServices.materialization.bitbucketScmHostingBasicAuth',
      'provider.request.before',
      'sidechain.start',
      'acme.hooks.custom',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          hooks: [{ ...providerResponseHook, id }],
        },
      }).success, id).toBe(false);
    }
  });

  it('accepts manifest-declared request interceptors with order and plugin-fetch targets only', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.policy',
      version: '1.0.0',
      displayName: 'Acme Policy',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: [],
      },
      contributes: {
        requestInterceptors: [
          {
            id: 'acme.policy.egress',
            order: 20,
            targets: [
              {
                scope: 'plugin-fetch',
                urlOrigins: ['https://api.example.test'],
              },
            ],
          },
        ],
      },
      capabilities: {
        permissions: [
          {
            capability: 'network.intercept',
            reason: 'Mediate plugin and Happier server requests',
          },
        ],
      },
    });

    expect(parsed.contributes.requestInterceptors).toEqual([
      {
        id: 'acme.policy.egress',
        order: 20,
        targets: [
          {
            scope: 'plugin-fetch',
            urlOrigins: ['https://api.example.test'],
          },
        ],
      },
    ]);
    expect(parsed.capabilities.permissions.map((entry: { capability: string }) => entry.capability))
      .toContain('network.intercept');
  });

  it('rejects stale request interceptor priority and unknown target scopes', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.policy',
      version: '1.0.0',
      displayName: 'Acme Policy',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: [] },
      capabilities: { permissions: [{ capability: 'network.intercept' }] },
    };

    expect(manifestSchema!.safeParse({
      ...baseManifest,
      contributes: {
        requestInterceptors: [
          {
            id: 'acme.policy.priority',
            priority: 10,
            targets: [{ scope: 'plugin-fetch' }],
          },
        ],
      },
    }).success).toBe(false);

    for (const invalidScope of [
      'marketplace',
      'provider-auth',
      'backend-runtime',
      'happier-server',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          requestInterceptors: [
            {
              id: 'acme.policy.unknown',
              order: 10,
              targets: [{ scope: invalidScope }],
            },
          ],
        },
      }).success, invalidScope).toBe(false);
    }

    for (const invalidUrlOrigin of [
      'api.example.test',
      'https://api.example.test/path',
      'https://api.example.test?token=value',
      'ftp://api.example.test',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          requestInterceptors: [
            {
              id: 'acme.policy.invalid-origin',
              order: 10,
              targets: [{ scope: 'plugin-fetch', urlOrigins: [invalidUrlOrigin] }],
            },
          ],
        },
      }).success, invalidUrlOrigin).toBe(false);
    }
  });

  it('normalizes backend execution-run capability support to the nested contract', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const defaultSupported = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.backend-default',
      version: '1.0.0',
      displayName: 'Acme Backend Default',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['backends'] },
      contributes: {
        agents: [
          {
            kindVersion: 1,
            id: 'acme.agent',
            display: { name: 'Acme Agent' },
            ownedBackendIds: ['acme.backend'],
          },
        ],
        backends: [
          {
            kindVersion: 1,
            id: 'acme.backend',
            agentId: 'acme.agent',
            engine: { kind: 'custom' },
          },
        ],
      },
      capabilities: { permissions: [] },
    });

    expect(defaultSupported.contributes.backends[0]?.capabilities).toEqual({
      executionRun: { supported: true },
      session: {
        media: {
          acceptsImageInput: { supported: false },
          emitsSessionMedia: { supported: false },
          nativeImageGeneration: { supported: false },
        },
        contextCompaction: {
          events: { supported: false },
          manualTrigger: { supported: false },
          transcriptInference: { supported: false },
        },
      },
    });

    const explicitOptOut = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.backend-opt-out',
      version: '1.0.0',
      displayName: 'Acme Backend Opt Out',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['backends'] },
      contributes: {
        agents: [
          {
            kindVersion: 1,
            id: 'acme.agent',
            display: { name: 'Acme Agent' },
            ownedBackendIds: ['acme.backend'],
          },
        ],
        backends: [
          {
            kindVersion: 1,
            id: 'acme.backend',
            agentId: 'acme.agent',
            engine: { kind: 'custom' },
            capabilities: {
              executionRun: { supported: false },
            },
          },
        ],
      },
      capabilities: { permissions: [] },
    });

    expect(explicitOptOut.contributes.backends[0]?.capabilities).toEqual({
      executionRun: { supported: false },
      session: {
        media: {
          acceptsImageInput: { supported: false },
          emitsSessionMedia: { supported: false },
          nativeImageGeneration: { supported: false },
        },
        contextCompaction: {
          events: { supported: false },
          manualTrigger: { supported: false },
          transcriptInference: { supported: false },
        },
      },
    });
  });

  it('accepts notification contribution families while rejecting stale activity providers', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.notifications',
      version: '1.0.0',
      displayName: 'Acme Notifications',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['notifications'],
      },
      contributes: {
        notifications: [
          {
            id: 'acme.notifications.reviewReady',
            kind: 'activity',
            title: 'Review ready',
            eventIds: ['ready'],
            defaultChannelIds: ['builtin:expo_push'],
          },
          {
            id: 'acme.notifications.approvalNeeded',
            kind: 'approval',
            title: 'Approval needed',
            eventIds: ['permission_request'],
          },
        ],
        notificationChannels: [
          {
            id: 'acme.notifications.webhook',
            kind: 'webhook',
            title: 'Acme webhook',
          },
        ],
      },
      capabilities: {
        permissions: [
          {
            capability: 'notifications.register',
            reason: 'Registers notification routing for Acme events',
          },
        ],
      },
    });

    expect(parsed.runtime.capabilities).toContain('notifications');
    expect(parsed.contributes.notifications.map((definition: { id: string }) => definition.id)).toEqual([
      'acme.notifications.reviewReady',
      'acme.notifications.approvalNeeded',
    ]);
    expect(parsed.contributes.notificationChannels.map((definition: { id: string }) => definition.id)).toEqual([
      'acme.notifications.webhook',
    ]);

    const legacyActivityProviderFamily = `activity${'Providers'}`;
    const staleActivityProviderManifest = {
      schemaVersion: 2,
      id: 'acme.notifications',
      version: '1.0.0',
      displayName: 'Acme Notifications',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['notifications'] },
      contributes: {
        [legacyActivityProviderFamily]: [
          {
            id: 'acme.activity',
          },
        ],
      },
      capabilities: {},
    };

    expect(manifestSchema!.safeParse(staleActivityProviderManifest).success).toBe(false);
  });

  it('accepts non-agent SCM hosting-provider contributions in nested contributes', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.scm',
      version: '1.0.0',
      displayName: 'Acme SCM',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['scmHostingProviders'],
      },
      contributes: {
        scmHostingProviders: [
          {
            id: 'acme.scm.github',
            kind: 'github',
            displayName: 'Acme GitHub',
            baseUrl: 'https://github.example.com',
          },
        ],
      },
      capabilities: {
        permissions: [],
      },
    });

    expect(parsed.contributes.scmHostingProviders).toEqual([
      expect.objectContaining({
        id: 'acme.scm.github',
        kind: 'github',
        urlSafety: expect.objectContaining({
          allowedSchemes: ['https:'],
        }),
      }),
    ]);
    expect(parsed.contributes.agents).toEqual([]);
    expect(parsed.contributes.backends).toEqual([]);
  });

  it('accepts connected-account descriptor contributions while rejecting secret-bearing descriptor metadata', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.auth',
      version: '1.0.0',
      displayName: 'Acme Auth',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['connectedAccountDescriptors'],
      },
      contributes: {
        connectedAccountDescriptors: [
          {
            id: 'gitlab',
            kind: 'auth.connectedAccount',
            version: '1',
            displayKey: 'plugins.acme.auth.gitlab.name',
            aliases: ['gitlab'],
            credentialKinds: ['token'],
            defaultCredentialKind: 'token',
            connectModes: [
              {
                targetId: 'gitlab',
                mode: 'token',
                credentialKind: 'token',
                default: true,
                tokenKind: 'personal-access-token',
              },
            ],
            tokenSetup: {
              tokenKind: 'personal-access-token',
              promptLabelKey: 'plugins.acme.auth.gitlab.tokenPrompt',
              missingValueErrorKey: 'plugins.acme.auth.gitlab.missingToken',
            },
            ui: {
              connectCommand: 'happier connect gitlab --token',
              oauthAddActionModes: [],
            },
            materialization: {
              materializationKinds: ['scm_hosting_token'],
            },
          },
        ],
      },
      capabilities: {
        permissions: [],
      },
    });

    expect(parsed.contributes.connectedAccountDescriptors).toEqual([
      expect.objectContaining({
        id: 'gitlab',
        kind: 'auth.connectedAccount',
        materialization: expect.objectContaining({
          materializationKinds: ['scm_hosting_token'],
        }),
      }),
    ]);

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.auth-secret',
      version: '1.0.0',
      displayName: 'Acme Auth Secret',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['connectedAccountDescriptors'] },
      contributes: {
        connectedAccountDescriptors: [
          {
            id: 'gitlab',
            kind: 'auth.connectedAccount',
            version: '1',
            displayKey: 'plugins.acme.auth.gitlab.name',
            credentialKinds: ['token'],
            defaultCredentialKind: 'token',
            connectModes: [],
            tokenSetup: {
              tokenKind: 'personal-access-token',
              promptLabelKey: 'plugins.acme.auth.gitlab.tokenPrompt',
              missingValueErrorKey: 'plugins.acme.auth.gitlab.missingToken',
              accessToken: 'must-not-live-in-manifest',
            },
            ui: {
              connectCommand: 'happier connect gitlab --token',
              oauthAddActionModes: [],
            },
          },
        ],
      },
      capabilities: { permissions: [] },
    }).success).toBe(false);
  });

  it('accepts nested MCP server/discovery-provider contribution families and rejects raw credential fields', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.mcp',
      version: '1.0.0',
      displayName: 'Acme MCP',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['mcp'] },
      contributes: {
        mcp: {
          servers: [
            {
              id: 'acme.hosted',
              kind: 'mcp.server',
              version: '1.0.0',
              name: 'acme-hosted',
              transport: 'hosted',
            },
          ],
          discoveryProviders: [
            {
              id: 'acme.discovery',
              kind: 'mcp.discoveryProvider',
              version: '1.0.0',
              providerId: 'acme',
            },
          ],
        },
      },
      capabilities: { permissions: [] },
    });

    expect(parsed.contributes.mcp.servers.map((server: { name: string }) => server.name)).toEqual(['acme-hosted']);
    expect(parsed.contributes.mcp.discoveryProviders.map((provider: { providerId: string }) => provider.providerId)).toEqual(['acme']);
    expect(parsed.runtime.capabilities).toContain('mcp');

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.retired-mcp',
      version: '1.0.0',
      displayName: 'Acme Retired MCP',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['mcp'] },
      contributes: {
        mcp: {
          tools: [
            {
              id: 'acme.tool',
              kind: 'mcp.tool',
              version: '1.0.0',
              name: 'ext.acme.search',
            },
          ],
        },
      },
      capabilities: { permissions: [] },
    }).success).toBe(false);

    const withRawCredential = {
      schemaVersion: 2,
      id: 'acme.mcp',
      version: '1.0.0',
      displayName: 'Acme MCP',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: [] },
      contributes: {
        mcp: {
          servers: [
            {
              id: 'acme.remote',
              kind: 'mcp.server',
              version: '1.0.0',
              name: 'acme-remote',
              transport: 'http',
              url: 'https://mcp.example.test',
              clientSecret: 'raw-value',
            },
          ],
        },
      },
      capabilities: {},
    };

    expect(manifestSchema!.safeParse(withRawCredential).success).toBe(false);
  });

  it('validates non-agent installable contributions in nested contributes', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.installables',
      version: '1.0.0',
      displayName: 'Acme Installables',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1, capabilities: [] },
      contributes: {
        installables: [
          {
            id: 'acme-tool',
            key: 'acme-tool',
            kind: 'dep',
            version: '1',
            capabilityId: 'dep.acme-tool',
            display: {
              name: 'Acme Tool',
            },
            description: 'Acme tool dependency',
            source: {
              kind: 'manual_only',
              setupUrl: 'https://example.com/acme-tool',
            },
            binary: {
              commands: ['acme-tool'],
              systemFirst: true,
            },
            defaultPolicy: {
              autoInstallWhenNeeded: false,
              autoUpdateMode: 'notify',
            },
            consent: {
              install: 'required',
              update: 'required',
            },
          },
        ],
      },
    });

    expect(parsed.contributes.installables).toEqual([
      expect.objectContaining({
        key: 'acme-tool',
        capabilityId: 'dep.acme-tool',
        source: expect.objectContaining({ kind: 'manual_only' }),
      }),
    ]);

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.invalid-installables',
      version: '1.0.0',
      displayName: 'Invalid Installables',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1, capabilities: [] },
      contributes: {
        installables: [
          {
            id: 'bad-tool',
            key: 'bad-tool',
            kind: 'dep',
            version: '1',
            capabilityId: 'dep.bad-tool',
            display: {
              name: 'Bad Tool',
            },
            description: 'Bad dependency',
            source: {
              kind: 'shell_script',
              command: 'curl https://example.com/install.sh | sh',
            },
            binary: {
              commands: ['bad-tool'],
              systemFirst: true,
            },
            defaultPolicy: {
              autoInstallWhenNeeded: false,
              autoUpdateMode: 'notify',
            },
            consent: {
              install: 'required',
              update: 'required',
            },
          },
        ],
      },
    }).success).toBe(false);
  });

  it('validates descriptor-driven settings contributions through the shared descriptor base', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.settings',
      version: '1.0.0',
      displayName: 'Acme Settings',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['settings'],
      },
      contributes: {
        settings: [
          {
            id: 'acme.settings.main',
            fields: [
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                control: 'text',
                displayKey: 'plugins.acme.settings.endpoint.label',
                order: 10,
                clearWhenEmpty: 'omit',
              },
              {
                id: 'enabled',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'boolean' },
                control: 'switch',
                displayKey: 'plugins.acme.settings.enabled.label',
                defaultBooleanValue: false,
                hidden: true,
              },
            ],
          },
        ],
      },
      capabilities: {
        permissions: [],
      },
    });

    const settings = (parsed.contributes as { settings?: Array<{ fields: Array<Record<string, unknown>> }> }).settings;
    expect(settings?.[0]?.fields[0]).toMatchObject({
      id: 'endpoint',
      clearWhenEmpty: 'omit',
      hidden: false,
    });
    expect(settings?.[0]?.fields[1]).toMatchObject({
      id: 'enabled',
      defaultBooleanValue: false,
      hidden: true,
    });

    const invalidSecretDescriptor = {
      schemaVersion: 2,
      id: 'acme.settings',
      version: '1.0.0',
      displayName: 'Acme Settings',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['settings'] },
      contributes: {
        settings: [
          {
            id: 'acme.settings.main',
            fields: [
              {
                id: 'bad-secret',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                control: 'password',
                displayKey: 'plugins.acme.settings.secret.label',
                metadata: {
                  accessToken: 'raw-secret-value',
                  client_secret: 'raw-client-secret',
                },
              },
            ],
          },
        ],
      },
      capabilities: {},
    };

    expect(manifestSchema!.safeParse(invalidSecretDescriptor).success).toBe(false);
  });

  it('validates execution-run profile contributions through the shared descriptor base', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.execution-runs',
      version: '1.0.0',
      displayName: 'Acme Execution Runs',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['executionRunProfiles'],
      },
      contributes: {
        executionRunProfiles: [
          {
            id: 'acme.review.profile',
            kind: 'executionRun.profile',
            version: '1.0.0',
            intent: 'review',
            displayKey: 'plugins.acme.executionRuns.review.label',
            order: 10,
            hidden: true,
          },
        ],
      },
      capabilities: {
        permissions: [],
      },
    });

    expect(parsed.contributes.executionRunProfiles).toEqual([
      expect.objectContaining({
        id: 'acme.review.profile',
        kind: 'executionRun.profile',
        intent: 'review',
        hidden: true,
        redaction: 'none',
      }),
    ]);

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.execution-runs.secret',
      version: '1.0.0',
      displayName: 'Acme Execution Runs Secret',
      engines: {
        happier: '^1.0.0',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['executionRunProfiles'],
      },
      contributes: {
        executionRunProfiles: [
          {
            id: 'acme.review.profile',
            kind: 'executionRun.profile',
            version: '1.0.0',
            intent: 'review',
            displayKey: 'plugins.acme.executionRuns.review.label',
            metadata: {
              accessToken: 'secret',
            },
          },
        ],
      },
      capabilities: {
        permissions: [],
      },
    }).success).toBe(false);
  });
});
