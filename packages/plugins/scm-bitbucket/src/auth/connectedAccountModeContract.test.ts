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
            expect.objectContaining({
              id: 'identity',
              title: 'Atlassian account email',
            }),
            expect.objectContaining({
              id: 'token',
              secret: true,
              description: expect.stringContaining('read:user:bitbucket'),
            }),
          ],
        }],
      },
    });
    expect(descriptor).not.toHaveProperty('auth');
  });

  /**
   * One recorded Bitbucket answer, and the requests that were actually sent to get it.
   *
   * The stub is the HTTP boundary and nothing below it: the credential encoding, the status
   * classification and the identity read are this module's real logic and run for every case.
   */
  function createHttpStub(
    answer: Readonly<{ status: number; body?: unknown }> | Error,
  ) {
    const requests: Readonly<Record<string, unknown>>[] = [];
    const http = {
      async request(request: Readonly<Record<string, unknown>>) {
        requests.push(request);
        if (answer instanceof Error) throw answer;
        return {
          status: answer.status,
          headers: {},
          body: new TextEncoder().encode(JSON.stringify(answer.body ?? {})),
        };
      },
    };
    return { requests, http };
  }

  function createCompletionContext(
    answer: Readonly<{ status: number; body?: unknown }> | Error,
    attempt: Readonly<{ kind: string; attemptId: string; account?: unknown }>
      = { kind: 'connect', attemptId: 'connect-attempt' },
  ) {
    const stored = new Map<string, string>();
    const { requests, http } = createHttpStub(answer);
    return {
      stored,
      requests,
      context: {
        attempt,
        attemptCredentials: {
          async get(key: string) { return stored.get(key) ?? null; },
          async set(key: string, value: string) { stored.set(key, value); },
          async delete(key: string) { stored.delete(key); },
        },
        services: { http },
        signal: new AbortController().signal,
      },
    };
  }

  /** The account Bitbucket answers with; `uuid` is documented as the account's immutable id. */
  const VIEWER_BODY = Object.freeze({
    uuid: '{9f1c2a44-5d0e-4c8b-8b0a-1d7e6f3a2c19}',
    nickname: 'example-maintainer',
    display_name: 'Example Maintainer',
  });

  it('proves the credential against Bitbucket and takes identity from the provider, not from the typed field', async () => {
    // Accepting any non-empty pair connects an account that cannot read anything: the first scan
    // is where a typo'd token is discovered, long after the connect flow said "connected". And a
    // `providerIdentity` built from the typed email is a user-supplied string standing in for the
    // provider's own immutable account id — two different people can type the same one, and one
    // person can type two.
    const connect = createCompletionContext({ status: 200, body: VIEWER_BODY });
    const authentication = bitbucketConnectedAccountRuntime.authentication.modes.manual;
    expect(authentication?.kind).toBe('manual');
    if (!authentication || authentication.kind !== 'manual') return;

    const connected = await authentication.complete({
      fields: { identity: ' account@example.com ', token: ' token-secret ' },
    }, connect.context as unknown as Parameters<typeof authentication.complete>[1]);

    expect(connect.requests).toHaveLength(1);
    expect(connect.requests[0]).toMatchObject({
      url: 'https://api.bitbucket.org/2.0/user',
      method: 'GET',
      // A followed redirect would deliver this credential to whatever host the answer named.
      redirect: 'error',
    });
    expect((connect.requests[0]?.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${btoa('account@example.com:token-secret')}`);

    expect(connected).toMatchObject({
      status: 'connected',
      providerIdentity: { accountId: '{9f1c2a44-5d0e-4c8b-8b0a-1d7e6f3a2c19}' },
    });
    expect(Object.fromEntries(connect.stored))
      .toEqual({ identity: 'account@example.com', token: 'token-secret' });
  });

  it('rejects a credential Bitbucket refuses and stores nothing', async () => {
    const attempt = createCompletionContext({ status: 401, body: { type: 'error' } });
    const authentication = bitbucketConnectedAccountRuntime.authentication.modes.manual;
    if (!authentication || authentication.kind !== 'manual') return;

    const result = await authentication.complete({
      fields: { identity: 'account@example.com', token: 'wrong-token' },
    }, attempt.context as unknown as Parameters<typeof authentication.complete>[1]);

    expect(result).toMatchObject({ status: 'rejected' });
    // A rejected attempt must leave no credential behind for a later read to succeed with.
    expect(Object.fromEntries(attempt.stored)).toEqual({});
  });

  it('reports an unreachable Bitbucket as unavailable rather than as a bad credential', async () => {
    const attempt = createCompletionContext(new Error('network down'));
    const authentication = bitbucketConnectedAccountRuntime.authentication.modes.manual;
    if (!authentication || authentication.kind !== 'manual') return;

    const result = await authentication.complete({
      fields: { identity: 'account@example.com', token: 'token-secret' },
    }, attempt.context as unknown as Parameters<typeof authentication.complete>[1]);

    // Telling a reader their token is wrong when the network was down sends them to rotate a
    // working credential.
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(Object.fromEntries(attempt.stored)).toEqual({});
  });

  it('reports a stored credential Bitbucket now refuses as needing reconnection', async () => {
    const stored = new Map<string, string>([
      ['identity', 'account@example.com'],
      ['token', 'revoked-token'],
    ]);
    const { http } = createHttpStub({ status: 401, body: { type: 'error' } });

    const health = await bitbucketConnectedAccountRuntime.status({
      credentials: {
        async get(key: string) { return stored.get(key) ?? null; },
        async set() { /* health never writes */ },
        async delete() { /* health never writes */ },
      },
      services: { http },
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof bitbucketConnectedAccountRuntime.status>[0]);

    // Credential PRESENCE is not credential health. Reporting `connected` from presence alone is
    // why a revoked token reads as a working account until the next scan fails.
    expect(health).toMatchObject({ status: 'reconnectRequired' });
  });

  it('keeps the canonical account id immutable while reporting mutable provider identity', async () => {
    const authentication = bitbucketConnectedAccountRuntime.authentication.modes.manual;
    if (!authentication || authentication.kind !== 'manual') return;

    // The same person, reconnecting with a renamed login and a replacement token. The canonical
    // account id stays the one the host already admitted; only the observed provider identity and
    // the stored credentials move.
    const reconnect = createCompletionContext({ status: 200, body: VIEWER_BODY }, {
      kind: 'reconnect',
      attemptId: 'reconnect-attempt',
      account: {
        service: {
          pluginId: 'happier.scm.forge.bitbucket',
          contributionId: 'bitbucket-account',
        },
        accountId: 'account@example.com',
      },
    });

    const result = await authentication.complete({
      fields: { identity: ' renamed@example.com ', token: ' replacement-token ' },
    }, reconnect.context as unknown as Parameters<typeof authentication.complete>[1]);

    expect(result).toEqual({
      status: 'connected',
      accountId: 'account@example.com',
      providerIdentity: { accountId: VIEWER_BODY.uuid },
      displayName: 'example-maintainer',
      scopes: [],
    });
    expect(Object.fromEntries(reconnect.stored)).toEqual({
      identity: 'renamed@example.com',
      token: 'replacement-token',
    });
  });
});
