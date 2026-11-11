import { describe, expect, it } from 'vitest';

import { OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR } from './stateSharing.js';

describe('OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR', () => {
  it('declares the strict Agent launch descriptor without a routing provider id', () => {
    expect(OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR).toEqual({
      nativeHome: { environmentKey: 'XDG_DATA_HOME', defaultRelativePath: '.local/share' },
      providerSupportStatus: 'supported',
      config: {
        supported: false,
        modes: ['isolated'],
        entries: [],
        unavailableReason: 'not_implemented',
      },
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        entries: [{ path: 'opencode/opencode.db', mode: 'linked' }],
        sharedStatePrivacyRiskAcknowledgementRequired: true,
        symlinkUnavailableDegradePolicy: 'block_continuity',
      },
      authIsolation: {
        mode: 'process_env',
        secretEntries: ['OPENCODE_AUTH_CONTENT', 'opencode/auth.json'],
      },
    });
    expect(OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR).not.toHaveProperty('providerId');
  });
});
