import { describe, expect, it } from 'vitest';
import type { ConnectedAccountAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CODER_CONNECTED_ACCOUNT_RUNTIME, CODER_PORTABLE_ACCOUNT_RUNTIME } from './connection.js';

const password = 'private-first-administrator-password';
const token = 'private-coder-session-token';
const fields = { email: 'admin@example.test', username: 'admin', password };
const created = { user_id: 'first-user', organization_id: 'first-organization' };
type Http = PluginInvocationContext['services']['http'];
type Request = Parameters<Http['request']>[0];
type Reply = { status: number; body: unknown; finalUrl?: string; afterReply?: () => void } | Error;

function fixture(replies: Reply[], endpoint = 'https://coder.example.test') {
  const credentials = new Map<string, string>();
  const requests: Request[] = [];
  const abort = new AbortController();
  const http: Http = { async request(request, options) {
    expect(options?.signal).toBe(abort.signal);
    requests.push(request);
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected HTTP request');
    if (reply instanceof Error) throw reply;
    reply.afterReply?.();
    return { status: reply.status, finalUrl: reply.finalUrl ?? request.url, headers: {},
      body: new TextEncoder().encode(JSON.stringify(reply.body)) };
  } };
  // Authentication host services are the HTTP boundary; no unrelated daemon services are exercised.
  const context = { signal: abort.signal, services: { http }, attempt: { kind: 'connect', attemptId: 'attempt' },
    configuration: { values: { endpoint } }, attemptCredentials: {
      async set(key: string, value: string) { credentials.set(key, value); },
      async get(key: string) { return credentials.get(key) ?? null; },
      async delete(key: string) { credentials.delete(key); },
    } } as unknown as ConnectedAccountAuthenticationContext;
  const complete = async (host: 'native' | 'portable' = 'native') => {
    const runtime = host === 'native' ? CODER_CONNECTED_ACCOUNT_RUNTIME : CODER_PORTABLE_ACCOUNT_RUNTIME;
    const mode = runtime.authentication?.modes['first-admin'];
    expect(mode?.kind).toBe('manual');
    if (mode?.kind !== 'manual') throw new Error('Missing first-administrator authentication');
    const result = await mode.complete({ fields }, context);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(token);
    return result;
  };
  return { complete, context, requests, credentials, abort };
}

describe('Coder first administrator authentication', () => {
  it.each(['native', 'portable'] as const)('creates the first user through the %s authentication host, signs in and stages only the usable token', async host => {
    const h = fixture([{ status: 201, body: created }, { status: 201, body: { session_token: token } }]);
    expect(await h.complete(host)).toEqual({ status: 'connected', displayName: 'https://coder.example.test', scopes: [] });
    expect(h.requests.map(request => ({ url: request.url, method: request.method, redirect: request.redirect,
      body: JSON.parse(new TextDecoder().decode(request.body)) }))).toEqual([
      { url: 'https://coder.example.test/api/v2/users/first', method: 'POST', redirect: 'error', body: { ...fields, trial: false } },
      { url: 'https://coder.example.test/api/v2/users/login', method: 'POST', redirect: 'error', body: { email: fields.email, password } },
    ]);
    expect([...h.credentials]).toEqual([['token', token]]);
    expect(h.context.configuration.values).toEqual({ endpoint: 'https://coder.example.test' });
  });

  it('recovers a previous or interrupted creation by signing in after native conflict without retrying creation', async () => {
    const h = fixture([{ status: 409, body: { message: password } }, { status: 201, body: { session_token: token } }]);
    expect(await h.complete()).toMatchObject({ status: 'connected' });
    expect(h.requests.map(request => new URL(request.url).pathname)).toEqual(['/api/v2/users/first', '/api/v2/users/login']);
    expect(h.credentials.get('token')).toBe(token);
  });

  it.each(['http://coder.example.test', 'https://user:pass@coder.example.test', 'https://coder.example.test/path', 'https://coder.example.test?secret=x'])
  ('refuses unsafe endpoint %s before disclosing credentials', async endpoint => {
    const h = fixture([], endpoint);
    expect(await h.complete()).toMatchObject({ status: 'rejected' });
    expect(h.requests).toEqual([]);
    expect(h.credentials.size).toBe(0);
  });

  it('leaves uncertain creation visible and lets a new attempt recover through native conflict', async () => {
    const h = fixture([new Error(password), { status: 409, body: {} }, { status: 201, body: { session_token: token } }]);
    expect(await h.complete()).toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'coder_first_admin_create_transport' } });
    expect(h.requests).toHaveLength(1);
    expect(h.credentials.size).toBe(0);
    expect(await h.complete()).toMatchObject({ status: 'connected' });
  });

  it.each([400, 403, 429, 500])('preserves create HTTP %i without reflecting native error text', async status => {
    const h = fixture([{ status, body: { message: password, detail: token } }]);
    expect(await h.complete()).toMatchObject({ diagnostic: { code: `coder_first_admin_create_http_${status}` } });
    expect(h.requests).toHaveLength(1);
    expect(h.credentials.size).toBe(0);
  });

  it.each([undefined, null, {}, { user_id: 'user' }])('does not sign in after malformed successful creation: %j', async body => {
    const h = fixture([{ status: 201, body }]);
    expect(await h.complete()).toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'coder_first_admin_create_response_invalid' } });
    expect(h.requests).toHaveLength(1);
    expect(h.credentials.size).toBe(0);
  });

  it.each([undefined, null, {}, { session_token: '' }, { session_token: 'bad\r\ntoken' }])('does not stage malformed login response: %j', async body => {
    const h = fixture([{ status: 201, body: created }, { status: 201, body }]);
    expect(await h.complete()).toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'coder_first_admin_login_response_invalid' } });
    expect(h.credentials.size).toBe(0);
  });

  it('reports an existing first user with invalid sign-in credentials without overwriting or storing them', async () => {
    const h = fixture([{ status: 409, body: {} }, { status: 401, body: { message: password } }]);
    expect(await h.complete()).toMatchObject({ status: 'rejected', diagnostic: { code: 'coder_first_admin_login_http_401' } });
    expect(h.credentials.size).toBe(0);
  });

  it('keeps lost login replies recoverable without automatically retrying or persisting a password', async () => {
    const h = fixture([{ status: 201, body: created }, new Error(token)]);
    expect(await h.complete()).toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'coder_first_admin_login_transport' } });
    expect(h.requests).toHaveLength(2);
    expect(h.credentials.size).toBe(0);
  });

  it('never follows an endpoint change or sends the next credential request there', async () => {
    const h = fixture([{ status: 201, body: created, finalUrl: 'https://other.example.test/api/v2/users/first' }]);
    expect(await h.complete()).toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'coder_first_admin_create_origin_changed' } });
    expect(h.requests).toHaveLength(1);
    expect(h.credentials.size).toBe(0);
  });

  it('honors cancellation before dispatch and between creation and sign-in without staging', async () => {
    const before = fixture([]); before.abort.abort(new Error(password));
    expect(await before.complete()).toMatchObject({ status: 'rejected', diagnostic: { code: 'coder_first_admin_cancelled' } });
    expect(before.requests).toHaveLength(0);
    const between = fixture([{ status: 201, body: created, afterReply: () => between.abort.abort(new Error(password)) }]);
    expect(await between.complete()).toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'coder_first_admin_cancelled' } });
    expect(between.requests).toHaveLength(1);
    expect(between.credentials.size).toBe(0);
  });

  it('does not publish a token received after cancellation or reflect a credential-store failure', async () => {
    const cancelled = fixture([{ status: 201, body: created }, { status: 201, body: { session_token: token },
      afterReply: () => cancelled.abort.abort(new Error(password)) }]);
    expect(await cancelled.complete()).toMatchObject({ status: 'outcomeUnknown', diagnostic: { code: 'coder_first_admin_cancelled' } });
    expect(cancelled.credentials.size).toBe(0);
    const failed = fixture([{ status: 201, body: created }, { status: 201, body: { session_token: token } }]);
    failed.context.attemptCredentials.set = async () => { throw new Error(token); };
    expect(await failed.complete()).toMatchObject({ status: 'unavailable', diagnostic: { code: 'coder_first_admin_credential_store_failed' } });
    expect(failed.credentials.size).toBe(0);
  });

  it('preserves existing portable token authentication', async () => {
    const mode = CODER_PORTABLE_ACCOUNT_RUNTIME.authentication?.modes.token;
    if (mode?.kind !== 'manual') throw new Error('Missing token authentication');
    const h = fixture([], 'http://coder.example.test');
    expect(await mode.complete({ fields: { token } }, h.context)).toMatchObject({ status: 'connected' });
    expect([...h.credentials]).toEqual([['token', token]]);
    expect(h.requests).toEqual([]);
  });
});
