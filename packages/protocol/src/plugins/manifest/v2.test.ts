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
        urlSafety: {
          allowedSchemes: ['https:'],
        },
      }),
    ]);
    expect(parsed.contributes.agents).toEqual([]);
    expect(parsed.contributes.backends).toEqual([]);
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
});
