import { describe, expect, it } from 'vitest';

import {
  containsProviderRegisteredSecret,
  redactProviderDiagnosticText,
  redactProviderHeadersForDiagnostics,
  redactProviderUrlForDiagnostics,
} from './index.js';

describe('provider diagnostic redaction', () => {
  it('retains URL structure and query names but never query values or fragments', () => {
    const redacted = redactProviderUrlForDiagnostics(
      'https://gateway.example.test/v1/reset/tok9f8e7d6c5b4a3210ffeeddcc?api-version=2024&token=secret#fragment',
    );
    expect(redacted).toEqual({
      origin: 'https://gateway.example.test',
      path: '/v1/reset/:redacted',
      queryKeys: ['api-version'],
    });
    expect(JSON.stringify(redacted)).not.toContain('2024');
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(JSON.stringify(redacted)).not.toContain('fragment');
  });

  it('retains validated header names only', () => {
    expect(redactProviderHeadersForDiagnostics({
      'X-Title': 'private tenant name',
      'HTTP-Referer': 'https://private.example.test',
    })).toEqual(['http-referer', 'x-title']);
  });

  it('redacts every registered secret/header/query value, longest first', () => {
    const output = redactProviderDiagnosticText(
      'request failed: sk-secret-long and sk-secret; tenant alpha; query q-value',
      {
        secretValues: ['sk-secret', 'sk-secret-long'],
        headerValues: ['tenant alpha'],
        queryValues: ['q-value'],
      },
    );
    expect(output).toBe('request failed: [REDACTED] and [REDACTED]; [REDACTED]; query [REDACTED]');
  });

  it('detects an exact registered secret echoed under an innocuous field name', () => {
    expect(containsProviderRegisteredSecret('model-sk-secret', ['sk-secret'])).toBe(true);
    expect(containsProviderRegisteredSecret('ordinary-model', ['sk-secret'])).toBe(false);
    expect(containsProviderRegisteredSecret('ordinary-model', ['', ''])).toBe(false);
  });
});
