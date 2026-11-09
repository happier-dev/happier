import { describe, expect, it } from 'vitest';

import {
  isBaseCredentialDiagnosticKey,
  isExactBaseCredentialKey,
  splitSensitiveDiagnosticKeySegments,
} from './sensitiveKeys.js';

describe('base diagnostic credential-key classifier', () => {
  it('projects configuration with the same vocabulary matched only as whole keys', () => {
    for (const key of ['apiKey', 'API_KEY', 'api-key', 'apikey', 'password', 'accessToken', 'clientSecret']) {
      expect(isExactBaseCredentialKey(key)).toBe(true);
    }
    for (const key of ['passwordPolicy', 'token', 'tokenCount', 'body']) {
      expect(isExactBaseCredentialKey(key)).toBe(false);
    }
    // Diagnostic containment remains intentionally broader than configuration projection.
    expect(isBaseCredentialDiagnosticKey('passwordPolicy')).toBe(true);
  });

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
    'recoverySecret',
    'recovery_key',
    'machineKey',
    'secretKey',
    'claim-secret',
    'pairingSecret',
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
