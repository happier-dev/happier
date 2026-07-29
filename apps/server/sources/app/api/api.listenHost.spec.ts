import { describe, expect, it } from 'vitest';
import fastify from 'fastify';

import {
  API_CORS_ALLOWED_HEADERS,
  API_CORS_EXPOSED_HEADERS,
  createApiCorsOptions,
  DEFAULT_API_CORS_MAX_AGE_SECONDS,
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
  it('uses a conservative default preflight cache duration', () => {
    expect(resolveApiCorsMaxAgeSeconds({})).toBe(DEFAULT_API_CORS_MAX_AGE_SECONDS);
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
  it('allows the opt-in session-list timing diagnostic request header for browser profiling', () => {
    expect(API_CORS_ALLOWED_HEADERS).toEqual(expect.arrayContaining([
      'authorization',
      'content-type',
      'x-happier-session-list-timing',
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
  it('lets browser profiling preflight the timing header and read Server-Timing', async () => {
    const app = fastify();
    app.register(import('@fastify/cors'), createApiCorsOptions({}));
    app.get('/probe', async (_request, reply) => {
      reply.header('Server-Timing', 'happier_v2_sessions_total;dur=1.000');
      return { ok: true };
    });

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: {
        origin: 'http://example.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-happier-session-list-timing',
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'http://example.test' },
    });
    await app.close();

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('x-happier-session-list-timing');
    expect(response.headers['server-timing']).toBe('happier_v2_sessions_total;dur=1.000');
    expect(response.headers['access-control-expose-headers']).toContain('server-timing');
  });
});
