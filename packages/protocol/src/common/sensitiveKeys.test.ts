import { describe, expect, it } from 'vitest';

import {
  isBaseCredentialDiagnosticKey,
  splitSensitiveDiagnosticKeySegments,
} from './sensitiveKeys.js';

describe('base diagnostic credential-key classifier', () => {
  it.each([
    'authorization',
    'accessToken',
    'refresh_token',
    'api-key',
    'apikey',
    'clientSecret',
    'password',
    'cookie',
    'jwt',
    'privateKey',
    'passphrase',
  ])('classifies %s through exact segments', (key) => {
    expect(isBaseCredentialDiagnosticKey(key)).toBe(true);
  });

  it('keeps count and prose names out of the credential vocabulary', () => {
    expect(splitSensitiveDiagnosticKeySegments('accessToken')).toEqual(['access', 'token']);
    for (const key of ['sessionCount', 'tokenCount', 'secretary']) {
      expect(isBaseCredentialDiagnosticKey(key)).toBe(false);
    }
  });
});
