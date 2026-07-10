import { describe, expect, it } from 'vitest';

import {
  normalizeProviderCredentialHeaderName,
  normalizeProviderPublicHeaders,
  normalizeProviderQueryParameterName,
} from './index.js';

describe('provider header safety', () => {
  it('normalizes benign public attribution headers deterministically', () => {
    expect(normalizeProviderPublicHeaders({
      'X-Title': 'Happier',
      'HTTP-Referer': 'https://happier.dev',
    })).toEqual({
      'http-referer': 'https://happier.dev',
      'x-title': 'Happier',
    });
  });

  it.each([
    'Authorization',
    'x-api-key',
    'API-Key',
    'apikey',
    'X-ApiKey',
    'x-access-token',
    'Cookie',
    'Set-Cookie',
    'Host',
    'Content-Length',
    'Connection',
    'Proxy-Authorization',
    'Transfer-Encoding',
  ])('rejects public secret-bearing or transport-owned header %s', (name) => {
    expect(() => normalizeProviderPublicHeaders({ [name]: 'value' })).toThrow();
  });

  it('rejects controls and case-equivalent duplicate public headers', () => {
    expect(() => normalizeProviderPublicHeaders({ 'X-Title': 'ok\r\nAuthorization: secret' })).toThrow();
    expect(() => normalizeProviderPublicHeaders({ 'X-Title': 'one', 'x-title': 'two' })).toThrow();
  });

  it.each(['__proto__', 'prototype', 'constructor', 'Constructor'])(
    'rejects poison object-key header name %s for public and credential destinations',
    (name) => {
      expect(() => normalizeProviderPublicHeaders({ [name]: 'value' })).toThrow();
      expect(() => normalizeProviderCredentialHeaderName(name)).toThrow();
    },
  );

  it('allows benign names that merely contain a poison-key word', () => {
    expect(normalizeProviderPublicHeaders({ 'X-Constructor-Hint': 'safe' })).toEqual({
      'x-constructor-hint': 'safe',
    });
    expect(normalizeProviderCredentialHeaderName('X-Prototype-Token')).toBe('x-prototype-token');
  });

  it('uses a distinct credential-destination validator that permits auth names but not hop-by-hop names', () => {
    expect(normalizeProviderCredentialHeaderName(' Authorization ')).toBe('authorization');
    expect(normalizeProviderCredentialHeaderName('X-API-Key')).toBe('x-api-key');
    expect(() => normalizeProviderCredentialHeaderName('Host')).toThrow();
    expect(() => normalizeProviderCredentialHeaderName('Proxy-Authorization')).toThrow();
  });

  it('validates credential query names separately from header syntax', () => {
    expect(normalizeProviderQueryParameterName('api_key')).toBe('api_key');
    expect(() => normalizeProviderQueryParameterName('api key')).toThrow();
    expect(() => normalizeProviderQueryParameterName('token\nnext')).toThrow();
  });
});
