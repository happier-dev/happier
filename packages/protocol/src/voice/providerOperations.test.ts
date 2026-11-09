import { describe, expect, it } from 'vitest';

import {
  classifyVoiceProviderHttpFailure,
  normalizeVoiceFailureCode,
  readVoiceProviderCredentialRemediationCode,
  VoiceProviderCredentialRemediationCodeSchema,
} from './providerOperations';

describe('Voice provider operation failure classification', () => {
  it.each([
    [' provider:error-1.2 ', 'provider:error-1.2'],
    ['A'.repeat(128), 'A'.repeat(128)],
    ['A'.repeat(129), null],
    ['1provider_error', null],
    ['private provider message /Users/private', null],
    [{ private: 'provider detail' }, null],
  ])('retains the existing diagnostic-code boundary for %s', (code, expected) => {
    expect(normalizeVoiceFailureCode(code)).toBe(expected);
  });

  it.each([401, 403])(
    'classifies provider HTTP %s as unavailable credentials without inspecting provider text',
    (status) => {
      expect(classifyVoiceProviderHttpFailure(status)).toBe('credential_unavailable');
    },
  );

  it('keeps successful and malformed-response neighbors distinct', () => {
    expect(classifyVoiceProviderHttpFailure(204)).toBeNull();
    expect(classifyVoiceProviderHttpFailure(500)).toBe('provider_response_invalid');
    expect(classifyVoiceProviderHttpFailure(Number.NaN)).toBe('provider_response_invalid');
  });

  it('classifies a provider throttle as rate limited', () => {
    expect(classifyVoiceProviderHttpFailure(429)).toBe('rate_limited');
  });

  it('admits only canonical credential/access remediation codes from unknown failures', () => {
    expect(VoiceProviderCredentialRemediationCodeSchema.parse(
      'credential_access_review_required',
    )).toBe('credential_access_review_required');
    expect(readVoiceProviderCredentialRemediationCode({
      code: 'credential_unavailable',
      message: 'provider returned a private response',
    })).toBe('credential_unavailable');
    expect(readVoiceProviderCredentialRemediationCode({
      code: 'credential_access_review_required',
      message: 'recipient contract changed',
    })).toBe('credential_access_review_required');
    expect(readVoiceProviderCredentialRemediationCode({
      code: 'provider_response_invalid',
    })).toBeNull();
    expect(readVoiceProviderCredentialRemediationCode({
      code: 'private provider response body',
    })).toBeNull();
  });
});
