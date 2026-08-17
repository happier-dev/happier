import { describe, expect, it } from 'vitest';

import {
  DaemonPluginSecretDeleteRequestSchema,
  DaemonPluginSecretSetRequestSchema,
  DaemonPluginSecretSetResponseSchema,
  DaemonPluginSecretStatusRequestSchema,
  DaemonPluginSecretStatusResponseSchema,
  DaemonPluginSettingsGetRequestSchema,
  DaemonPluginSettingsGetResponseSchema,
  DaemonPluginSettingsSetRequestSchema,
  DaemonPluginSettingsSetResponseSchema,
} from '../daemon/contributionRegistryProjection.js';
import { RPC_METHODS } from './index.js';

describe('RPC_METHODS plugin settings surface', () => {
  it('defines daemon plugin settings get and set methods', () => {
    expect(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET).toBe('daemon.plugins.settings.get');
    expect(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET).toBe('daemon.plugins.settings.set');
  });

  it('carries the canonical settings revision through reads and optional compare-and-set writes', () => {
    expect(DaemonPluginSettingsGetResponseSchema.parse({
      protocolVersion: 1,
      pluginId: 'acme.hooks',
      scope: { kind: 'account' },
      revision: '7',
      values: { enabled: true },
      redactedKeys: [],
    })).toMatchObject({ revision: '7', scope: { kind: 'account' } });

    expect(DaemonPluginSettingsSetRequestSchema.parse({
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      scope: { kind: 'account' },
      fieldId: 'enabled',
      mutation: { kind: 'set', value: false },
      expectedRevision: '7',
    }).expectedRevision).toBe('7');
  });

  it('makes daemon settings mutation outcomes explicit and returns only safe snapshots', () => {
    const snapshot = {
      protocolVersion: 1,
      pluginId: 'acme.hooks',
      scope: { kind: 'daemon' as const },
      revision: '8',
      values: { enabled: false },
      redactedKeys: ['api-token'],
    };

    expect(DaemonPluginSettingsSetResponseSchema.parse({
      status: 'applied',
      snapshot,
    })).toMatchObject({
      status: 'applied',
      snapshot: { revision: '8', redactedKeys: ['api-token'] },
    });
    expect(DaemonPluginSettingsSetResponseSchema.parse({
      status: 'conflict',
      snapshot,
    })).toMatchObject({
      status: 'conflict',
      snapshot: { revision: '8', values: { enabled: false } },
    });
    expect(DaemonPluginSettingsSetResponseSchema.safeParse(snapshot).success).toBe(false);
    expect(DaemonPluginSettingsSetResponseSchema.safeParse({
      status: 'outcomeUnknown',
      snapshot,
    }).success).toBe(false);
  });

  it('requires the exact server and machine identity instead of accepting a machine-only daemon target', () => {
    expect(DaemonPluginSettingsGetRequestSchema.safeParse({
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      scope: { kind: 'daemon' },
    }).success).toBe(false);

    expect(DaemonPluginSettingsSetRequestSchema.safeParse({
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      scope: { kind: 'daemon' },
      fieldId: 'enabled',
      mutation: { kind: 'set', value: false },
    }).success).toBe(false);

    expect(DaemonPluginSecretStatusRequestSchema.safeParse({
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      secretId: 'api-token',
    }).success).toBe(false);

    expect(DaemonPluginSecretDeleteRequestSchema.safeParse({
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      secretId: 'api-token',
    }).success).toBe(false);
  });

  it('requires explicit secret deletion so an empty string remains settable data', () => {
    expect(DaemonPluginSettingsSetRequestSchema.parse({
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      scope: { kind: 'daemon' },
      fieldId: 'token',
      mutation: { kind: 'set', value: '' },
    }).mutation).toEqual({ kind: 'set', value: '' });

    expect(DaemonPluginSettingsSetRequestSchema.parse({
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      scope: { kind: 'daemon' },
      fieldId: 'token',
      mutation: { kind: 'delete' },
    }).mutation).toEqual({ kind: 'delete' });

    expect(DaemonPluginSettingsSetRequestSchema.safeParse({
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      scope: { kind: 'daemon' },
      fieldId: 'token',
      value: '',
    }).success).toBe(false);

    expect(DaemonPluginSettingsSetRequestSchema.safeParse({
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      scope: { kind: 'daemon' },
      fieldId: 'token',
      mutation: { kind: 'set' },
    }).success).toBe(false);
  });

  it('defines origin-scoped daemon-secret status/set/delete transport with no raw read field', () => {
    expect(RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS).toBe('daemon.plugins.secrets.status');
    expect(RPC_METHODS.DAEMON_PLUGIN_SECRET_SET).toBe('daemon.plugins.secrets.set');
    expect(RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE).toBe('daemon.plugins.secrets.delete');

    expect(DaemonPluginSecretStatusRequestSchema.parse({
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      secretId: 'api-token',
      canonicalOrigin: 'https://api.example.test',
    }).canonicalOrigin).toBe('https://api.example.test');

    expect(DaemonPluginSecretStatusResponseSchema.parse({
      protocolVersion: 1,
      pluginId: 'acme.hooks',
      secretId: 'api-token',
      state: 'configured',
      revision: 'secret-r1:configured',
    })).toMatchObject({ state: 'configured', revision: 'secret-r1:configured' });

    expect(DaemonPluginSecretSetRequestSchema.parse({
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      secretId: 'api-token',
      canonicalOrigin: 'https://api.example.test',
      value: 'new-secret-material-only-at-the-mutation-boundary',
      expectedRevision: 'secret-r1:configured',
    }).canonicalOrigin).toBe('https://api.example.test');
    expect(DaemonPluginSecretSetResponseSchema.safeParse({
      protocolVersion: 1,
      pluginId: 'acme.hooks',
      secretId: 'api-token',
      state: 'configured',
      revision: 'secret-r2:configured',
      value: 'must-never-cross-the-daemon-secret-rpc',
    }).success).toBe(false);

    expect(DaemonPluginSecretDeleteRequestSchema.parse({
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      secretId: 'api-token',
      expectedRevision: 'secret-r1:configured',
    }).expectedRevision).toBe('secret-r1:configured');

    expect(DaemonPluginSecretStatusResponseSchema.safeParse({
      protocolVersion: 1,
      pluginId: 'acme.hooks',
      secretId: 'api-token',
      state: 'configured',
      revision: 'secret-r1:configured',
      value: 'must-never-cross-the-daemon-secret-rpc',
    }).success).toBe(false);
  });
});
