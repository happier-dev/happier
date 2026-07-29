import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from './accountSettings.js';

describe('connected-account purpose binding settings', () => {
  it('defaults old settings to one empty qualified binding map and preserves explicit intent', () => {
    expect(accountSettingsParse({}).connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [],
    });

    expect(accountSettingsParse({
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: { pluginId: 'happier.agent.test', localId: 'runtime' },
            purpose: 'model-request',
          },
          target: {
            kind: 'group',
            service: { pluginId: 'happier.connected-account.test', localId: 'subscription' },
            groupId: 'fallbacks',
          },
        }],
      },
    }).connectedAccountPurposeBindingsV1.bindings).toHaveLength(1);
  });
});
