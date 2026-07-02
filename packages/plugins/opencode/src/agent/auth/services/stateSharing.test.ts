import { describe, expect, it } from 'vitest';

import { OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR } from './stateSharing.js';

describe('OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR', () => {
  it('declares OpenCode auth isolation through process env without provider state sharing', () => {
    expect(OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR).toMatchObject({
      providerId: 'opencode',
      providerSupportStatus: { supportLevel: 'unsupported' },
      authIsolation: {
        mode: 'process_env',
        env: ['OPENCODE_AUTH_CONTENT'],
        secretEntries: ['OPENCODE_AUTH_CONTENT', 'auth.json'],
      },
      configSharing: { mode: 'unsupported' },
      stateSharing: { mode: 'unsupported' },
    });
  });
});
