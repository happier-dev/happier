import { describe, expect, it } from 'vitest';

import { resolveOpenAiCompatEndpointConsent } from './endpoint';

describe('resolveOpenAiCompatEndpointConsent', () => {
  it('normalizes an exact HTTPS origin without requiring insecure consent', () => {
    expect(resolveOpenAiCompatEndpointConsent('https://gateway.example.test/v1/', null, null, 'machine-a')).toEqual({
      normalizedBaseUrl: 'https://gateway.example.test/v1/',
      origin: 'https://gateway.example.test',
      requiresInsecureConsent: false,
      insecureLocalOriginConsent: null,
      insecureLocalConsentMachineId: null,
    });
  });

  it('requires HTTP consent tied to the exact origin and invalidates changed origins', () => {
    expect(resolveOpenAiCompatEndpointConsent('http://localhost:11434/v1', null, null, 'machine-a')).toMatchObject({
      origin: 'http://localhost:11434',
      requiresInsecureConsent: true,
      insecureLocalOriginConsent: null,
    });
    expect(resolveOpenAiCompatEndpointConsent(
      'http://localhost:11434/v1',
      'http://localhost:11434',
      'machine-a',
      'machine-a',
    )).toMatchObject({
      insecureLocalOriginConsent: 'http://localhost:11434',
      insecureLocalConsentMachineId: 'machine-a',
    });
    expect(resolveOpenAiCompatEndpointConsent(
      'http://localhost:11435/v1',
      'http://localhost:11434',
      'machine-a',
      'machine-a',
    ))
      .toMatchObject({ origin: 'http://localhost:11435', insecureLocalOriginConsent: null });
  });

  it('invalidates insecure consent when the selected execution machine changes', () => {
    expect(resolveOpenAiCompatEndpointConsent(
      'http://localhost:11434/v1',
      'http://localhost:11434',
      'machine-a',
      'machine-b',
    )).toMatchObject({
      insecureLocalOriginConsent: null,
      insecureLocalConsentMachineId: null,
    });
  });

  it('rejects userinfo and query credentials before persisting an endpoint', () => {
    expect(() => resolveOpenAiCompatEndpointConsent('https://user:secret@example.test/v1', null, null, 'machine-a')).toThrow();
    expect(() => resolveOpenAiCompatEndpointConsent('https://example.test/v1?api_key=secret', null, null, 'machine-a')).toThrow();
  });
});
