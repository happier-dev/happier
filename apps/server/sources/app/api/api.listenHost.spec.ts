import { describe, expect, it } from 'vitest';

import { DEFAULT_API_CORS_MAX_AGE_SECONDS, resolveApiCorsMaxAgeSeconds, resolveApiListenHost } from './api';

describe('resolveApiListenHost', () => {
  it('defaults to 0.0.0.0', () => {
    expect(resolveApiListenHost({})).toBe('0.0.0.0');
  });

  it('prefers HAPPIER_SERVER_HOST', () => {
    expect(resolveApiListenHost({ HAPPIER_SERVER_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('falls back to HAPPY_SERVER_HOST', () => {
    expect(resolveApiListenHost({ HAPPY_SERVER_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

describe('resolveApiCorsMaxAgeSeconds', () => {
  it('uses a conservative default preflight cache duration', () => {
    expect(resolveApiCorsMaxAgeSeconds({})).toBe(DEFAULT_API_CORS_MAX_AGE_SECONDS);
  });

  it('accepts a non-negative override', () => {
    expect(resolveApiCorsMaxAgeSeconds({ HAPPIER_API_CORS_MAX_AGE_SECONDS: '120' })).toBe(120);
  });

  it('falls back when the override is invalid', () => {
    expect(resolveApiCorsMaxAgeSeconds({ HAPPIER_API_CORS_MAX_AGE_SECONDS: '-1' })).toBe(DEFAULT_API_CORS_MAX_AGE_SECONDS);
    expect(resolveApiCorsMaxAgeSeconds({ HAPPIER_API_CORS_MAX_AGE_SECONDS: 'nope' })).toBe(DEFAULT_API_CORS_MAX_AGE_SECONDS);
  });
});
