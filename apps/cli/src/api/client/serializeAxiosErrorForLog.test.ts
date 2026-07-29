import { describe, expect, it } from 'vitest';

import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';

import { serializeAxiosErrorForLog } from './serializeAxiosErrorForLog';

function createAxiosConfig(params: Readonly<{
  method: string;
  url: string;
  headers?: AxiosHeaders;
  data?: unknown;
}>): InternalAxiosRequestConfig {
  return {
    method: params.method,
    url: params.url,
    headers: params.headers ?? new AxiosHeaders(),
    ...(params.data === undefined ? {} : { data: params.data }),
  };
}

describe('serializeAxiosErrorForLog', () => {
  it('redacts query params and does not include headers/body', () => {
    const err = new AxiosError('boom', 'ECONNABORTED', createAxiosConfig({
      method: 'get',
      url: 'https://api.example.test/v1/account/settings?token=secret&x=1#hash',
      headers: new AxiosHeaders({ Authorization: 'Bearer SECRET', 'Content-Type': 'application/json' }),
      data: { secret: 'nope' },
    }));

    const serialized = serializeAxiosErrorForLog(err);
    expect(serialized).toEqual(expect.objectContaining({
      name: 'AxiosError',
      message: expect.any(String),
      code: expect.any(String),
      method: 'GET',
      url: 'https://api.example.test/v1/account/settings',
    }));
    expect(serialized).not.toHaveProperty('headers');
    expect(serialized).not.toHaveProperty('data');
  });

  it('includes safe machine-readable response error fields without logging request or response bodies', () => {
    const config = createAxiosConfig({
      method: 'post',
      url: 'https://api.example.test/v2/connect/provider-account-usage/record?token=secret',
      headers: new AxiosHeaders({ Authorization: 'Bearer SECRET', 'Content-Type': 'application/json' }),
      data: { sealed: { ciphertext: 'SECRET_CIPHERTEXT' } },
    });
    const err = new AxiosError(
      'Request failed with status 400',
      'ERR_BAD_REQUEST',
      config,
      undefined,
      {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config,
        data: {
          error: 'invalid-params',
          reason: 'connected_service_usage_source_incompatible',
          message: 'secret should not be logged',
        },
      },
    );

    const serialized = serializeAxiosErrorForLog(err);

    expect(serialized).toEqual(expect.objectContaining({
      status: 400,
      responseError: 'invalid-params',
      responseReason: 'connected_service_usage_source_incompatible',
    }));
    expect(serialized).not.toHaveProperty('data');
    expect(serialized).not.toHaveProperty('headers');
    expect(JSON.stringify(serialized)).not.toContain('SECRET_CIPHERTEXT');
    expect(JSON.stringify(serialized)).not.toContain('secret should not be logged');
  });

  it('redacts Telegram bot tokens embedded in path segments', () => {
    const err = new AxiosError('boom', 'ECONNRESET', createAxiosConfig({
      method: 'post',
      url: 'https://api.telegram.org/bot123456:ABC-SECRET/sendMessage',
    }));

    const serialized = serializeAxiosErrorForLog(err);
    expect(serialized).toEqual(expect.objectContaining({
      method: 'POST',
      url: 'https://api.telegram.org/<redacted>/sendMessage',
    }));
  });

  it('redacts URL userinfo credentials', () => {
    const err = new AxiosError('boom', 'ECONNRESET', createAxiosConfig({
      method: 'get',
      url: 'https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/features?token=secret',
    }));

    const serialized = serializeAxiosErrorForLog(err);
    expect(serialized).toEqual(expect.objectContaining({
      method: 'GET',
      url: 'https://api.example.test/v1/features',
    }));
    expect(JSON.stringify(serialized)).not.toContain('SUPER_SECRET_PASSWORD');
    expect(JSON.stringify(serialized)).not.toContain('alice');
    expect(JSON.stringify(serialized)).not.toContain('token=secret');
  });

  it('redacts userinfo from scheme-relative URL-like strings in the fallback path', () => {
    const err = new AxiosError('boom', 'ECONNRESET', createAxiosConfig({
      method: 'get',
      url: '//alice:SUPER_SECRET_PASSWORD@api.example.test/v1/features?token=secret',
    }));

    const serialized = serializeAxiosErrorForLog(err);
    expect(serialized).toEqual(expect.objectContaining({
      method: 'GET',
      url: '//api.example.test/v1/features',
    }));
    expect(JSON.stringify(serialized)).not.toContain('SUPER_SECRET_PASSWORD');
    expect(JSON.stringify(serialized)).not.toContain('alice');
    expect(JSON.stringify(serialized)).not.toContain('token=secret');
  });

  it('redacts URL userinfo credentials in opaque URL-like strings', () => {
    const err = new AxiosError('boom', 'ECONNRESET', createAxiosConfig({
      method: 'get',
      url: 'alice:SUPER_SECRET_PASSWORD@api.example.test/v1/features?token=secret',
    }));

    const serialized = serializeAxiosErrorForLog(err);
    expect(serialized).toEqual(expect.objectContaining({
      method: 'GET',
      url: 'api.example.test/v1/features',
    }));
    expect(JSON.stringify(serialized)).not.toContain('SUPER_SECRET_PASSWORD');
    expect(JSON.stringify(serialized)).not.toContain('alice');
    expect(JSON.stringify(serialized)).not.toContain('token=secret');
  });

  it('redacts username-only userinfo in no-scheme URL-like strings', () => {
    const err = new AxiosError('boom', 'ECONNRESET', createAxiosConfig({
      method: 'get',
      url: 'TOKEN_ONLY@api.example.test/v1/features?token=secret',
    }));

    const serialized = serializeAxiosErrorForLog(err);
    expect(serialized).toEqual(expect.objectContaining({
      method: 'GET',
      url: 'api.example.test/v1/features',
    }));
    expect(JSON.stringify(serialized)).not.toContain('TOKEN_ONLY');
    expect(JSON.stringify(serialized)).not.toContain('token=secret');
  });

  it('redacts URL secrets embedded in Error messages', () => {
    const err = new Error(
      'socket failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/features?token=secret#hash',
    );

    const serialized = serializeAxiosErrorForLog(err);
    expect(serialized).toEqual(expect.objectContaining({
      name: 'Error',
      message: 'socket failed for https://api.example.test/v1/features',
    }));
    expect(JSON.stringify(serialized)).not.toContain('SUPER_SECRET_PASSWORD');
    expect(JSON.stringify(serialized)).not.toContain('alice');
    expect(JSON.stringify(serialized)).not.toContain('token=secret');
  });

  it('redacts Telegram bot tokens embedded in string errors', () => {
    const serialized = serializeAxiosErrorForLog(
      'failed https://api.telegram.org/bot123456:ABC-SECRET/sendMessage?chat_id=secret',
    );

    expect(serialized).toEqual({
      message: 'failed https://api.telegram.org/<redacted>/sendMessage',
    });
    expect(JSON.stringify(serialized)).not.toContain('123456:ABC-SECRET');
    expect(JSON.stringify(serialized)).not.toContain('chat_id=secret');
  });

  it('redacts authorization tokens embedded in string errors', () => {
    const serialized = serializeAxiosErrorForLog(
      'request failed with Authorization: Bearer SUPER_SECRET_TOKEN',
    );

    expect(serialized).toEqual({
      message: 'request failed with Authorization: <redacted>',
    });
    expect(JSON.stringify(serialized)).not.toContain('SUPER_SECRET_TOKEN');
    expect(JSON.stringify(serialized)).not.toContain('Bearer');
  });
});
