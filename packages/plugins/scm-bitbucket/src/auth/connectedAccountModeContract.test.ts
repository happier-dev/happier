import { describe, expect, it } from 'vitest';

import { bitbucketConnectedAccountRuntime } from './connectedAccountRuntime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('Bitbucket Connected Account mode contract', () => {
  it('declares its manual credentials as the final default authentication mode', () => {
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors[0];

    expect(descriptor).toMatchObject({
      id: 'bitbucket-account',
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [
            expect.objectContaining({ id: 'identity' }),
            expect.objectContaining({ id: 'token', secret: true }),
          ],
        }],
      },
    });
    expect(descriptor).not.toHaveProperty('auth');
  });

  it('keeps the canonical account id immutable while reporting mutable provider identity', async () => {
    const authentication = bitbucketConnectedAccountRuntime.authentication.modes.manual;
    expect(authentication?.kind).toBe('manual');
    if (!authentication || authentication.kind !== 'manual') return;

    const credentialValues = new Map<string, string>();
    const attemptCredentials = {
      async get(key: string) { return credentialValues.get(key) ?? null; },
      async set(key: string, value: string) { credentialValues.set(key, value); },
      async delete(key: string) { credentialValues.delete(key); },
    };
    const connectResult = await authentication.complete({
      fields: { identity: ' account@example.com ', token: ' token-secret ' },
    }, {
      attempt: { kind: 'connect', attemptId: 'connect-attempt' },
      attemptCredentials,
    } as Parameters<typeof authentication.complete>[1]);
    expect(connectResult).toEqual({
      status: 'connected',
      providerIdentity: {
        accountId: 'account@example.com',
      },
      displayName: 'account@example.com',
      scopes: [],
    });

    const reconnectCredentialValues = new Map<string, string>();
    const reconnectResult = await authentication.complete({
      fields: { identity: ' renamed@example.com ', token: ' replacement-token ' },
    }, {
      attempt: {
        kind: 'reconnect',
        attemptId: 'reconnect-attempt',
        account: {
          service: {
            pluginId: 'happier.scm.hosting.bitbucket',
            contributionId: 'bitbucket-account',
          },
          accountId: 'account@example.com',
        },
      },
      attemptCredentials: {
        async get(key: string) { return reconnectCredentialValues.get(key) ?? null; },
        async set(key: string, value: string) { reconnectCredentialValues.set(key, value); },
        async delete(key: string) { reconnectCredentialValues.delete(key); },
      },
    } as Parameters<typeof authentication.complete>[1]);
    expect(reconnectResult).toEqual({
      status: 'connected',
      accountId: 'account@example.com',
      providerIdentity: {
        accountId: 'renamed@example.com',
      },
      displayName: 'renamed@example.com',
      scopes: [],
    });
    expect(Object.fromEntries(reconnectCredentialValues)).toEqual({
      identity: 'renamed@example.com',
      token: 'replacement-token',
    });
  });
});
