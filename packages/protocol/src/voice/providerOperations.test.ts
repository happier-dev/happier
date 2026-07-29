import { describe, expect, it } from 'vitest';

import {
  classifyVoiceProviderHttpFailure,
  readVoiceProviderCredentialRemediationCode,
  VoiceProviderCredentialRemediationCodeSchema,
} from './providerOperations';

describe('Voice provider operation failure classification', () => {
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
