import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceOauthErrorMessage } from './resolveConnectedServiceOauthErrorMessage';

describe('resolveConnectedServiceOauthErrorMessage', () => {
  it('maps oauth state mismatch to a friendly message', () => {
    const message = resolveConnectedServiceOauthErrorMessage(new Error('connect_oauth_state_mismatch'), 'fallback');
    expect(message).toBe('Security validation failed. Please try again');
  });

  it('maps oauth timeout to a friendly message', () => {
    const message = resolveConnectedServiceOauthErrorMessage(new Error('connect_oauth_timeout'), 'fallback');
    expect(message).toBe('Connection timed out');
  });

  it('hides opaque oauth machine codes', () => {
    const message = resolveConnectedServiceOauthErrorMessage(new Error('connect_oauth_exchange_failed'), 'fallback');
    expect(message).toBe('fallback');
  });

  it('maps oauth invalid client to a friendly token-exchange error', () => {
    const message = resolveConnectedServiceOauthErrorMessage(new Error('connect_oauth_invalid_client'), 'fallback');
    expect(message).toBe('Failed to exchange authorization code');
  });

  it('maps oauth invalid grant to a friendly token-exchange error', () => {
    const message = resolveConnectedServiceOauthErrorMessage(new Error('connect_oauth_invalid_grant'), 'fallback');
    expect(message).toBe('Failed to exchange authorization code');
  });

  it('keeps human-readable error messages', () => {
    const message = resolveConnectedServiceOauthErrorMessage(new Error('Token exchange failed: 400'), 'fallback');
    expect(message).toBe('Token exchange failed: 400');
  });
});
