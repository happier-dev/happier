import { describe, expect, it } from 'vitest';

import {
  PluginSettingsAdministrationActionInputSchemasV1,
  PluginSettingsAdministrationActionOutputV1Schema,
} from './settingsAdministration.js';

describe('plugin Settings administration action inputs', () => {
  it('requires one exact target for a scope-selected CAS mutation', () => {
    const schema = PluginSettingsAdministrationActionInputSchemasV1['plugins.settings.set'];

    expect(schema.safeParse({
      pluginId: 'acme.settings',
      scope: { kind: 'account' },
      target: { kind: 'account' },
      localId: 'theme',
      value: 'dark',
      expectedRevision: '7',
    }).success).toBe(true);

    expect(schema.safeParse({
      pluginId: 'acme.settings',
      scope: { kind: 'daemon' },
      target: { kind: 'account' },
      localId: 'theme',
      value: 'dark',
    }).success).toBe(false);
  });

  it('permits secret binding by existing SavedSecret id without accepting raw secret bytes', () => {
    const schema = PluginSettingsAdministrationActionInputSchemasV1['plugins.settings.secret.bind'];

    expect(schema.safeParse({
      pluginId: 'acme.settings',
      localId: 'token',
      savedSecretId: 'saved-secret-1',
    }).success).toBe(true);
    expect(schema.safeParse({
      pluginId: 'acme.settings',
      localId: 'token',
      savedSecretId: 'saved-secret-1',
      value: 'must-never-be-an-action-input',
    }).success).toBe(false);
    expect(schema.safeParse({
      pluginId: 'acme.settings',
      localId: 'token',
      savedSecretId: 'saved-secret-1',
      scope: { kind: 'daemon' },
      target: { kind: 'account' },
    }).success).toBe(false);
  });

  it('uses one exact daemon target for daemon-custodied secrets independently of Settings scope', () => {
    const schema = PluginSettingsAdministrationActionInputSchemasV1['plugins.settings.secret.status'];
    const daemonTarget = {
      kind: 'daemon',
      serverIdentityId: 'srv_settings_1',
      machineId: 'machine-1',
    };

    expect(schema.safeParse({
      pluginId: 'acme.settings',
      localId: 'daemon-token',
      secretDaemonTarget: daemonTarget,
    }).success).toBe(true);
    expect(schema.safeParse({
      pluginId: 'acme.settings',
      localId: 'daemon-token',
      scope: { kind: 'account' },
      target: { kind: 'account' },
      secretDaemonTarget: daemonTarget,
    }).success).toBe(true);
    expect(schema.safeParse({
      pluginId: 'acme.settings',
      localId: 'daemon-token',
      scope: { kind: 'daemon' },
      target: daemonTarget,
      secretDaemonTarget: {
        ...daemonTarget,
        machineId: 'machine-2',
      },
    }).success).toBe(false);
    expect(schema.safeParse({
      pluginId: 'acme.settings',
      localId: 'daemon-token',
      expectedRevision: 'must-not-apply-to-a-read',
    }).success).toBe(false);
  });

  it('projects secret administration results through the safe status vocabulary only', () => {
    const safeStatus = {
      ok: true,
      kind: 'plugins.settings.secret.status',
      data: {
        localId: 'token',
        custody: 'account',
        target: { kind: 'account' },
        state: 'configured',
        revision: 'account-secret-r1:1',
      },
    } as const;

    expect(PluginSettingsAdministrationActionOutputV1Schema.safeParse(safeStatus).success).toBe(true);
    expect(PluginSettingsAdministrationActionOutputV1Schema.safeParse({
      ...safeStatus,
      data: {
        ...safeStatus.data,
        value: 'must-never-be-a-secret-result',
      },
    }).success).toBe(false);
    expect(PluginSettingsAdministrationActionOutputV1Schema.safeParse({
      ...safeStatus,
      data: {
        ...safeStatus.data,
        unexpected: 'must-never-be-a-secret-result',
      },
    }).success).toBe(false);
    expect(PluginSettingsAdministrationActionOutputV1Schema.safeParse({
      ...safeStatus,
      details: { value: 'must-never-be-a-secret-result' },
    }).success).toBe(false);
  });
});
