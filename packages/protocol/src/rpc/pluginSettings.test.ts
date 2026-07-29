import { describe, expect, it } from 'vitest';

import {
  DaemonPluginSettingsGetResponseSchema,
  DaemonPluginSettingsSetRequestSchema,
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
      storageScope: 'synced',
      revision: '7',
      values: { enabled: true },
      redactedKeys: [],
    })).toMatchObject({ revision: '7', storageScope: 'synced' });

    expect(DaemonPluginSettingsSetRequestSchema.parse({
      machineId: 'machine-1',
      pluginId: 'acme.hooks',
      fieldId: 'enabled',
      value: false,
      expectedRevision: '7',
    }).expectedRevision).toBe('7');
  });
});
