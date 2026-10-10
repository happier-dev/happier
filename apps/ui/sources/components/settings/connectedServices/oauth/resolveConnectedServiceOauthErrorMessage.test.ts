import { describe, expect, it } from 'vitest';
import { ConnectedServiceCredentialBindingMismatchError } from '@happier-dev/protocol';

import { resolveConnectedServiceOauthErrorMessage } from './resolveConnectedServiceOauthErrorMessage';

describe('resolveConnectedServiceOauthErrorMessage', () => {
  it('makes missing Google project and account eligibility failures actionable', () => {
    expect(resolveConnectedServiceOauthErrorMessage(new Error('connect_oauth_project_required'), 'fallback')).not.toBe('fallback');
    expect(resolveConnectedServiceOauthErrorMessage(new Error('connect_oauth_account_ineligible'), 'fallback')).not.toBe('fallback');
  });
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

  it('maps credential binding mismatch to a visible profile-target error', () => {
    const message = resolveConnectedServiceOauthErrorMessage(new ConnectedServiceCredentialBindingMismatchError({
      serviceId: 'openai-codex',
      profileId: 'work',
    }), 'fallback');
    expect(message).toBe('This reconnect returned credentials for a different connected profile. Start reconnect again from the target profile.');
  });

  it('keeps human-readable error messages', () => {
    const message = resolveConnectedServiceOauthErrorMessage(new Error('Token exchange failed: 400'), 'fallback');
    expect(message).toBe('Token exchange failed: 400');
  });
});
