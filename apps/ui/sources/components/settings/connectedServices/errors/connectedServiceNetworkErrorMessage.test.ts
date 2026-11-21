import { describe, expect, it } from 'vitest';

import { ConnectedServiceNetworkError } from '@/sync/api/account/connectedServiceNetworkError';

import { resolveConnectedServiceOauthErrorMessage } from '../oauth/resolveConnectedServiceOauthErrorMessage';
import { resolveConnectedServiceSettingsErrorMessage } from './connectedServiceSettingsErrors';

const unreachable = new ConnectedServiceNetworkError({
  operation: 'oauth-exchange',
  endpoint: '/v2/connect/claude-subscription/oauth/exchange',
  category: 'unreachable',
  cause: new TypeError('Failed to fetch'),
});
const timeout = new ConnectedServiceNetworkError({
  operation: 'oauth-exchange',
  endpoint: '/v2/connect/claude-subscription/oauth/exchange',
  category: 'timeout',
  cause: new Error('timed out'),
});

describe('connected-service connectivity messages', () => {
  it.each([
    ['oauth', resolveConnectedServiceOauthErrorMessage],
    ['settings', (error: unknown) => resolveConnectedServiceSettingsErrorMessage(error)],
  ] as const)('explains an unreachable server in the %s flow', (_flow, resolve) => {
    expect(resolve(unreachable, 'fallback')).toBe(
      'Cannot connect to the Happier server. Check your network or VPN connection and try again.',
    );
    expect(resolve(timeout, 'fallback')).toBe('The Happier server did not respond in time.');
  });

  it('does not report a raw fetch rejection as an authorization failure', () => {
    const raw = new TypeError('Failed to fetch');
    expect(resolveConnectedServiceOauthErrorMessage(raw, 'fallback')).toContain('Cannot connect to the Happier server');
    expect(resolveConnectedServiceSettingsErrorMessage(raw)).toContain('Cannot connect to the Happier server');
  });

  it('explains an OAuth state mismatch as a stale authorization response', () => {
    expect(resolveConnectedServiceOauthErrorMessage(new Error('connect_oauth_state_mismatch'), 'fallback')).toBe(
      'This authorization response does not match the current attempt. Start a new authorization.',
    );
  });

  it('shows a sanitized provider rejection instead of the raw redirect parameter', async () => {
    const { ConnectedServiceOauthRejectedError } = await import('../oauth/connectedServiceOauthErrors');
    expect(resolveConnectedServiceOauthErrorMessage(new ConnectedServiceOauthRejectedError('access_denied'), 'fallback'))
      .toBe('The provider rejected the authorization: access_denied');
    expect(resolveConnectedServiceOauthErrorMessage(new ConnectedServiceOauthRejectedError('<b>x</b> SECRET code=abc'), 'fallback'))
      .toBe('The provider rejected the authorization.');
  });

  it('reports a server HTTP failure with its status', () => {
    const error = Object.assign(new Error('connect_oauth_exchange_failed'), { code: 'connect_oauth_exchange_failed', status: 502 });
    expect(resolveConnectedServiceOauthErrorMessage(error, 'fallback')).toBe(
      'The Happier server returned an error (502). Try again in a moment.',
    );
  });
});
