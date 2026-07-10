import { describe, expect, it } from 'vitest';

import {
  accountSettingsParse,
} from '../../account/settings/accountSettings.js';
import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import { readProviderSettingsFromAccountSettingsV1 } from './readFromAccountSettingsV1.js';

const connection = {
  v: 1,
  id: 'pc_1',
  source: { kind: 'contribution', contributionKey: 'plugin:providers:p' },
  role: 'default',
  displayName: 'P',
  displayNameMode: 'automatic',
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
} as const;

describe('provider account settings integration', () => {
  it.each([6, 7])('preserves outer schema v%s and an absent provider subtree without provider-owned rewrites', (schemaVersion) => {
    const parsed = accountSettingsParse({ schemaVersion, xFuture: { preserved: true } });
    expect(parsed.schemaVersion).toBe(schemaVersion);
    expect(parsed.providerSettingsV1).toBeUndefined();
    expect(parsed.xFuture).toEqual({ preserved: true });
  });

  it('keeps future and malformed provider subtrees opaque across unrelated account parse round trips', () => {
    const cases = [
      { schemaVersion: 7, providerSettingsV1: { v: 2, opaque: { preserve: true } }, unrelated: 'x' },
      { schemaVersion: 6, providerSettingsV1: { v: 'bad', malformed: ['preserve'] }, unrelated: 'y' },
    ];
    for (const raw of cases) {
      const parsed = accountSettingsParse(raw);
      expect(parsed.providerSettingsV1).toEqual(raw.providerSettingsV1);
      expect(accountSettingsParse({ ...parsed, unrelated: `${raw.unrelated}-changed` }).providerSettingsV1)
        .toEqual(raw.providerSettingsV1);
    }
  });

  it('retains valid provider siblings through the canonical diagnostic reader when one record is malformed', () => {
    const visibility = serializeModelVisibilityRefV1({
      scope: 'agent', agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'x',
    });
    const raw = {
      schemaVersion: 7,
      providerSettingsV1: {
        v: 1,
        connections: [connection, { v: 1, id: '' }],
        connectionTombstones: [], accountGrants: [], machineGrants: [],
        secretBindingsByConnectionId: {}, manualModelsByConnectionId: {},
        modelVisibilityByRef: { [visibility]: 'hidden' },
        experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
      },
    };
    const parsed = accountSettingsParse(raw);
    const provider = readProviderSettingsFromAccountSettingsV1(parsed);
    expect(provider.settings.connections.map((entry) => entry.id)).toEqual(['pc_1']);
    expect(provider.settings.modelVisibilityByRef).toEqual({ [visibility]: 'hidden' });
    expect(provider.diagnostics).toContainEqual({ path: 'connections[1]', reason: 'invalid_record' });
  });
});
