import { describe, expect, it } from 'vitest';

import { OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR } from './stateSharing.js';

describe('OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR', () => {
  it('declares the strict Agent launch descriptor without a routing provider id', () => {
    expect(OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR).toEqual({
      providerSupportStatus: 'unsupported',
      config: {
        supported: false,
        modes: ['isolated'],
        entries: [],
        unavailableReason: 'not_implemented',
      },
      state: {
        supported: false,
        modes: ['isolated'],
        entries: [],
        symlinkUnavailableDegradePolicy: 'block_continuity',
        unavailableReason: 'not_implemented',
      },
      authIsolation: {
        mode: 'process_env',
        secretEntries: ['OPENCODE_AUTH_CONTENT', 'auth.json'],
      },
    });
    expect(OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR).not.toHaveProperty('providerId');
  });
});
