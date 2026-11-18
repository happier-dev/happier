import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { CHANGES_AFTER_CURSOR_HTTP_HEADER } from '@happier-dev/protocol/changes';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import {
  ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
  SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER,
} from '@happier-dev/protocol';

import {
  API_CORS_ALLOWED_HEADERS,
  API_CORS_EXPOSED_HEADERS,
  createApiCorsOptions,
  DEFAULT_API_CORS_MAX_AGE_SECONDS,
  enableContentTypeParsers,
  resolveApiCorsMaxAgeSeconds,
  resolveApiListenHost,
} from './api';

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
  it('lets browsers keep a preflight answer as long as Chromium honours one (2 h), from the registry default', () => {
    // Every distinct API URL from a cross-origin web app (app → api) is preflighted;
    // a 10-minute cache made each reopen after a short break pay one extra round trip per URL.
    expect(DEFAULT_API_CORS_MAX_AGE_SECONDS).toBe(SERVER_CONFIG.HAPPIER_API_CORS_MAX_AGE_SECONDS.default);
    expect(resolveApiCorsMaxAgeSeconds({})).toBe(7200);
  });

  it('accepts a non-negative override', () => {
    expect(resolveApiCorsMaxAgeSeconds({ HAPPIER_API_CORS_MAX_AGE_SECONDS: '120' })).toBe(120);
  });

  it('falls back when the override is invalid', () => {
    expect(resolveApiCorsMaxAgeSeconds({ HAPPIER_API_CORS_MAX_AGE_SECONDS: '-1' })).toBe(DEFAULT_API_CORS_MAX_AGE_SECONDS);
    expect(resolveApiCorsMaxAgeSeconds({ HAPPIER_API_CORS_MAX_AGE_SECONDS: 'nope' })).toBe(DEFAULT_API_CORS_MAX_AGE_SECONDS);
  });
});

describe('API_CORS_ALLOWED_HEADERS', () => {
  it('allows canonical browser request headers, including account stored-content compatibility', () => {
    expect(API_CORS_ALLOWED_HEADERS).toEqual(expect.arrayContaining([
      'authorization',
      'content-type',
      ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
      'idempotency-key',
      'if-none-match',
      'x-happier-session-list-timing',
      SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER,
    ]));
  });
});

describe('API_CORS_EXPOSED_HEADERS', () => {
  it('exposes server timing so browser clients can parse diagnostic route timings', () => {
    expect(API_CORS_EXPOSED_HEADERS).toEqual(expect.arrayContaining([
      'server-timing',
    ]));
  });
});

describe('createApiCorsOptions', () => {
  it('lets browser clients preflight canonical request headers and read timing and retry metadata', async () => {
    const app = fastify();
    app.register(import('@fastify/cors'), createApiCorsOptions({}));
    app.get('/probe', async (_request, reply) => {
      reply.header('Server-Timing', 'happier_v2_sessions_total;dur=1.000');
      reply.header('x-happier-retry-reason', 'server_unavailable');
      reply.header('ETag', '"current-public-representation"');
      reply.header('x-happier-account-settings-protocols', 'remote-alert-policy-v1');
      reply.header('x-happier-account-remote-alert-policy-status', 'stale');
      return { ok: true };
    });

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: {
        origin: 'http://example.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': [
          'authorization',
          CHANGES_AFTER_CURSOR_HTTP_HEADER,
          'content-type',
          ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
          'idempotency-key',
          'if-none-match',
          'x-happier-session-list-timing',
          SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER,
          AUTHORITY_CEILING_HEADER_V1,
          'x-happier-request-purpose',
        ].join(','),
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'http://example.test' },
    });
    await app.close();

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toContain(
      ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    );
    expect(preflight.headers['access-control-allow-headers']).toContain('idempotency-key');
    expect(preflight.headers['access-control-allow-headers']).toContain(CHANGES_AFTER_CURSOR_HTTP_HEADER);
    expect(response.headers['access-control-expose-headers']).toContain(CHANGES_AFTER_CURSOR_HTTP_HEADER);
    expect(response.headers['access-control-expose-headers']).toContain('x-happier-account-settings-protocols');
    expect(response.headers['x-happier-account-settings-protocols']).toBe('remote-alert-policy-v1');
    expect(response.headers['access-control-expose-headers']).toContain('x-happier-account-remote-alert-policy-status');
    expect(response.headers['x-happier-account-remote-alert-policy-status']).toBe('stale');
    expect(preflight.headers['access-control-allow-headers']).toContain('if-none-match');
    expect(preflight.headers['access-control-allow-headers']).toContain('x-happier-session-list-timing');
    expect(preflight.headers['access-control-allow-headers']).toContain(
      SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER,
    );
    expect(preflight.headers['access-control-allow-headers']).toContain(AUTHORITY_CEILING_HEADER_V1);
    expect(preflight.headers['access-control-allow-headers']).toContain('x-happier-request-purpose');
    expect(response.headers['server-timing']).toBe('happier_v2_sessions_total;dur=1.000');
    expect(response.headers['access-control-expose-headers']).toContain('server-timing');
    expect(response.headers['x-happier-retry-reason']).toBe('server_unavailable');
    expect(response.headers['access-control-expose-headers']).toContain('x-happier-retry-reason');
    expect(response.headers.etag).toBe('"current-public-representation"');
    expect(response.headers['access-control-expose-headers']).toContain('etag');
  });
});

describe('enableContentTypeParsers', () => {
  it('allows bodyless chunked POST requests without Content-Type to succeed without 415', async () => {
    const app = fastify();
    enableContentTypeParsers(app);
    app.post('/test-archive', async (request) => {
      return { success: true, body: request.body };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-archive',
      headers: {
        'transfer-encoding': 'chunked',
      },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
  });

  it('keeps Fastify JSON parsing for supported payloads', async () => {
    const app = fastify();
    enableContentTypeParsers(app);
    app.post('/test-json', async (request) => {
      return { received: request.body };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-json',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ hello: 'world' }),
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: { hello: 'world' } });
  });

  it('allows empty bodies with otherwise unsupported media types', async () => {
    const app = fastify();
    enableContentTypeParsers(app);
    app.post('/test-empty', async () => {
      return { ok: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-empty',
      headers: {
        'content-type': 'application/x-happier-proxy',
      },
      payload: '',
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('rejects non-empty bodies with unsupported media types', async () => {
    const app = fastify();
    enableContentTypeParsers(app);
    app.post('/test-unsupported', async (request) => {
      return { received: request.body };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-unsupported',
      headers: {
        'content-type': 'application/x-happier-proxy',
      },
      payload: JSON.stringify({ hello: 'world' }),
    });
    await app.close();

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual(expect.objectContaining({
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    }));
  });

  it('rejects whitespace-only bodies with unsupported media types', async () => {
    const app = fastify();
    enableContentTypeParsers(app);
    app.post('/test-unsupported-whitespace', async (request) => {
      return { received: request.body };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-unsupported-whitespace',
      headers: {
        'content-type': 'application/x-happier-proxy',
      },
      payload: '   ',
    });
    await app.close();

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual(expect.objectContaining({
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    }));
  });
  it('treats an empty application/json body as no body', async () => {
    const app = fastify();
    enableContentTypeParsers(app);
    app.delete('/test-empty-json', async (request) => {
      return { bodyIsUndefined: request.body === undefined };
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/test-empty-json',
      headers: {
        'content-type': 'application/json',
      },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bodyIsUndefined: true });
  });

  it('keeps default JSON parsing and prototype-poisoning protection for non-empty bodies', async () => {
    const app = fastify();
    enableContentTypeParsers(app);
    app.post('/test-json', async (request) => {
      return { received: request.body };
    });

    const parsed = await app.inject({
      method: 'POST',
      url: '/test-json',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: '{"hello":"world"}',
    });
    const poisoned = await app.inject({
      method: 'POST',
      url: '/test-json',
      headers: { 'content-type': 'application/json' },
      payload: '{"__proto__":{"polluted":true}}',
    });
    const malformed = await app.inject({
      method: 'POST',
      url: '/test-json',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    await app.close();

    expect(parsed.statusCode).toBe(200);
    expect(parsed.json()).toEqual({ received: { hello: 'world' } });
    expect(poisoned.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
  });
});
