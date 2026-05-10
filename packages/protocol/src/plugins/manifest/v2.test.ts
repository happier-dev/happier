import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import * as protocol from '../../index.js';

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

  it('accepts nested MCP contribution families and rejects raw credential fields', () => {
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
    });

    expect(parsed.contributes.mcp.servers.map((server: { name: string }) => server.name)).toEqual(['acme-hosted']);
    expect(parsed.contributes.mcp.tools.map((tool: { name: string }) => tool.name)).toEqual(['ext.acme.search']);
    expect(parsed.runtime.capabilities).toContain('mcp');

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
