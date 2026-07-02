import { describe, expect, it } from 'vitest';

import { buildSafeOauthProviderFailureMessage, readSafeOauthProviderErrorCode } from './safeOauthProviderError';

describe('readSafeOauthProviderErrorCode', () => {
  it('preserves compact provider error codes', () => {
    expect(readSafeOauthProviderErrorCode(JSON.stringify({ error: 'invalid_grant' }))).toBe('invalid_grant');
    expect(readSafeOauthProviderErrorCode(JSON.stringify({ error: { code: 'invalid_request' } }))).toBe(
      'invalid_request',
    );
    expect(readSafeOauthProviderErrorCode(JSON.stringify({ error: { type: 'invalid_request_error' } }))).toBe(
      'invalid_request_error',
    );
  });

  it('rejects provider error strings that contain token body fragments', () => {
    const body = JSON.stringify({
      error: 'invalid_grant refresh_token=secret-refresh-token access_token=secret-access-token',
    });

    expect(readSafeOauthProviderErrorCode(body)).toBeNull();
    expect(buildSafeOauthProviderFailureMessage({
      operation: 'Token exchange',
      status: 400,
      statusText: 'Bad Request',
      body,
    })).toBe('Token exchange failed (400): Bad Request');
  });
});
