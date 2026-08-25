import { describe, expect, it, vi } from 'vitest';

import type { ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('GitHub Connected Account mode contract', () => {
  it('declares a manual fine-grained PAT mode without reusing Happier login OAuth', () => {
    const descriptor = (PLUGIN_MANIFEST.contributes.connectedAccountDescriptors ?? [])[0];

    expect(descriptor).toMatchObject({
      id: 'github-account',
      authentication: {
        defaultModeId: 'fine-grained-pat',
        modes: [{
          id: 'fine-grained-pat',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [
            expect.objectContaining({ id: 'token', secret: true }),
          ],
        }],
      },
    });
    expect(descriptor).not.toHaveProperty('auth');
    expect(JSON.stringify(descriptor)).not.toContain('githubOAuth');
    expect((PLUGIN_MANIFEST.hostAccess?.required ?? [])[0]?.scope.targets).toContainEqual({
      kind: 'fixedOrigin',
      origin: 'https://api.github.com',
    });
  });

  it('confirms provider identity before staging a PAT and exposes reconnect identity mismatches', async () => {
    const registrations: Array<Readonly<{ id: string; runtime: PluginConnectedAccountRuntime }>> = [];
    const cleanup = await activate({
      actions: { register: vi.fn() },
      backgroundServices: { register: vi.fn() },
      scm: {
        registerHostingProvider() {
          return { dispose() {} };
        },
      },
      connectedAccounts: {
        register(id: string, runtime: PluginConnectedAccountRuntime) {
          registrations.push({ id, runtime });
          return { dispose() {} };
        },
      },
    } as unknown as Parameters<typeof activate>[0]);

    try {
      expect(registrations.map(({ id }) => id)).toEqual(['github-account']);
      const authentication = registrations[0]?.runtime.authentication.modes['fine-grained-pat'];
      expect(authentication?.kind).toBe('manual');
      if (!authentication || authentication.kind !== 'manual') return;

      const request = vi.fn()
        .mockResolvedValueOnce({
          status: 200,
          finalUrl: 'https://api.github.com/user',
          headers: { 'x-oauth-scopes': 'repo, read:org' },
          body: encodeJson({ id: 12_345, login: 'octocat', email: 'octocat@example.com' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          finalUrl: 'https://api.github.com/user',
          headers: {},
          body: encodeJson({ id: 67_890, login: 'renamed-octocat', email: null }),
        });
      const connectCredentialValues = new Map<string, string>();
      const connectResult = await authentication.complete({
        fields: { token: ' github_pat_test ' },
      }, {
        attempt: { kind: 'connect', attemptId: 'connect-attempt' },
        signal: new AbortController().signal,
        services: { http: { request } },
        attemptCredentials: {
          async get(key: string) { return connectCredentialValues.get(key) ?? null; },
          async set(key: string, value: string) { connectCredentialValues.set(key, value); },
          async delete(key: string) { connectCredentialValues.delete(key); },
        },
      } as unknown as Parameters<typeof authentication.complete>[1]);
      expect(connectResult).toEqual({
        status: 'connected',
        accountId: '12345',
        providerIdentity: { accountId: '12345', email: 'octocat@example.com' },
        displayName: 'octocat',
        scopes: ['repo', 'read:org'],
      });
      expect(connectCredentialValues).toEqual(new Map([['token', 'github_pat_test']]));
      expect(request).toHaveBeenNthCalledWith(1, {
        url: 'https://api.github.com/user',
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer github_pat_test' }),
        redirect: 'error',
      }, expect.objectContaining({ signal: expect.anything() }));

      const reconnectCredentialValues = new Map<string, string>();
      const reconnectResult = await authentication.complete({
        fields: { token: 'github_pat_replacement' },
      }, {
        attempt: {
          kind: 'reconnect',
          attemptId: 'reconnect-attempt',
          account: {
            service: {
              pluginId: 'happier.scm.forge.github',
              contributionId: 'github-account',
            },
            accountId: '12345',
          },
        },
        signal: new AbortController().signal,
        services: { http: { request } },
        attemptCredentials: {
          async get(key: string) { return reconnectCredentialValues.get(key) ?? null; },
          async set(key: string, value: string) { reconnectCredentialValues.set(key, value); },
          async delete(key: string) { reconnectCredentialValues.delete(key); },
        },
      } as unknown as Parameters<typeof authentication.complete>[1]);
      expect(reconnectResult).toEqual({
        status: 'connected',
        accountId: '67890',
        providerIdentity: { accountId: '67890' },
        displayName: 'renamed-octocat',
        scopes: [],
      });
      expect(reconnectCredentialValues).toEqual(new Map([['token', 'github_pat_replacement']]));
    } finally {
      if (typeof cleanup === 'function') await cleanup();
    }
  });

  it('does not stage a PAT when GitHub returns an invalid provider identity', async () => {
    const registrations: PluginConnectedAccountRuntime[] = [];
    const cleanup = await activate({
      actions: { register: vi.fn() },
      backgroundServices: { register: vi.fn() },
      scm: {
        registerHostingProvider() {
          return { dispose() {} };
        },
      },
      connectedAccounts: {
        register(_id: string, runtime: PluginConnectedAccountRuntime) {
          registrations.push(runtime);
          return { dispose() {} };
        },
      },
    } as unknown as Parameters<typeof activate>[0]);
    try {
      const authentication = registrations[0]?.authentication.modes['fine-grained-pat'];
      if (!authentication || authentication.kind !== 'manual') {
        throw new Error('GitHub fine-grained PAT mode was not registered');
      }

      const credentialValues = new Map<string, string>();
      const result = await authentication.complete({
        fields: { token: 'must-not-be-staged' },
      }, {
        attempt: { kind: 'connect', attemptId: 'invalid-identity-attempt' },
        signal: new AbortController().signal,
        services: {
          http: {
            request: vi.fn().mockResolvedValue({
              status: 200,
              finalUrl: 'https://api.github.com/user',
              headers: {},
              body: encodeJson({ id: 0, login: 'not-a-provider-account' }),
            }),
          },
        },
        attemptCredentials: {
          async get(key: string) { return credentialValues.get(key) ?? null; },
          async set(key: string, value: string) { credentialValues.set(key, value); },
          async delete(key: string) { credentialValues.delete(key); },
        },
      } as unknown as Parameters<typeof authentication.complete>[1]);

      expect(result).toMatchObject({
        status: 'unavailable',
        diagnostic: { code: 'github_identity_invalid' },
      });
      expect(credentialValues).toEqual(new Map());
      expect(JSON.stringify(result)).not.toContain('must-not-be-staged');
    } finally {
      if (typeof cleanup === 'function') await cleanup();
    }
  });
});
