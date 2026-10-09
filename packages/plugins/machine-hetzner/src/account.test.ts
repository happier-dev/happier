import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './account.js';

// Only the host credential store and HTTP boundary are substituted.
function context(status: number): ConnectedAccountReadContext {
  return { signal: new AbortController().signal, configuration: { values: { organizationSlug: 'team' } },
    credentials: { get: async () => 'private-token' }, services: { http: {
      request: async (request: { url: string }) => ({ status, finalUrl: request.url, headers: {},
        body: new TextEncoder().encode('{}') }),
    } },
  } as unknown as ConnectedAccountReadContext;
}
describe('hetzner captured account health', () => {
  it('distinguishes unavailable vendor service from rejected credentials', async () => {
    expect(await connectedAccountRuntime.status(context(503))).toMatchObject({ status: 'unavailable' });
    expect(await connectedAccountRuntime.status(context(403))).toMatchObject({ status: 'reconnectRequired' });
  });
});
