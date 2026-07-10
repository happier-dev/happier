import { describe, expect, it } from 'vitest';

import {
  ProviderEndpointSafetyError,
  assessProviderEndpoint,
  buildProviderEndpointSetFingerprintInput,
  evaluateProviderRedirect,
  normalizeProviderEndpointUrlSyntax,
  normalizeProviderOriginRelativePathSyntax,
} from './index.js';

describe('provider origin-relative executable path syntax', () => {
  it('normalizes a safe absolute path and preserves a benign query', () => {
    expect(normalizeProviderOriginRelativePathSyntax(
      '/v1/../models?api-version=2024-01-01',
      { allowQuery: true },
    )).toBe('/models?api-version=2024-01-01');
  });

  it('defaults to rejecting query parameters', () => {
    expect(() => normalizeProviderOriginRelativePathSyntax('/models?api-version=2024-01-01')).toThrowError(
      expect.objectContaining({ code: 'query_forbidden' }),
    );
  });

  it.each([
    ['models', 'invalid_url'],
    ['//evil.example/models', 'invalid_url'],
    ['/\\evil.example/models', 'invalid_url'],
    [' /models', 'control_character'],
    ['/models#fragment', 'fragment_forbidden'],
    ['/models%0aadmin', 'control_character'],
    ['/models?api%0akey=value', 'control_character'],
    ['/models?api-key=secret', 'secret_in_url'],
    ['/models?api-version=Bearer%20secret', 'secret_in_url'],
    ['/models?api-version=sk-secret', 'secret_in_url'],
  ])('rejects unsafe executable path %s', (rawPath, code) => {
    expect(() => normalizeProviderOriginRelativePathSyntax(rawPath, { allowQuery: true })).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});

describe('provider endpoint URL syntax normalization', () => {
  it('normalizes a hostname without requiring daemon DNS evidence', () => {
    expect(normalizeProviderEndpointUrlSyntax(
      'HTTPS://BÜCHER.example.:443/v1/../models?api-version=2024-01-01',
    )).toMatchObject({
      normalizedUrl: 'https://xn--bcher-kva.example/models?api-version=2024-01-01',
      hostname: 'xn--bcher-kva.example',
      protocol: 'https:',
      literalAddress: null,
    });
  });

  it.each([
    ['ftp://models.example.test/v1', 'unsupported_scheme'],
    ['https://user:secret@models.example.test/v1', 'userinfo_forbidden'],
    ['https://models.example.test/v1#fragment', 'fragment_forbidden'],
    ['https://models.example.test/\nmodels', 'control_character'],
    ['https://models.example.test/v1%0aadmin', 'control_character'],
    ['https://models.example.test/v1%0Dadmin', 'control_character'],
    ['https://models.example.test/v1%7fadmin', 'control_character'],
    ['https://models.example.test/v1%zzadmin', 'invalid_url'],
    ['https://models.example.test/%5c%5cevil.example/models', 'invalid_url'],
    ['https://models.example.test/%2f%2fevil.example/models', 'invalid_url'],
    ['http://2130706433:11434', 'odd_ip_encoding'],
    ['http://169.254.169.254/latest/meta-data', 'unsafe_address'],
    ['https://models.example.test/v1?api_key=secret', 'secret_in_url'],
  ])('rejects unsafe persisted URL syntax %s', (rawUrl, code) => {
    expect(() => normalizeProviderEndpointUrlSyntax(rawUrl)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it('can disallow every query for contexts whose schema has no non-secret query surface', () => {
    expect(() => normalizeProviderEndpointUrlSyntax(
      'https://models.example.test/v1?api-version=2024-01-01',
      { allowQuery: false },
    )).toThrowError(expect.objectContaining({ code: 'query_forbidden' }));
  });
});

describe('provider endpoint safety', () => {
  it('canonicalizes IDNA, default ports, dot segments, and trailing-dot hostnames', () => {
    const result = assessProviderEndpoint('HTTPS://BÜCHER.example.:443/v1/../models?api-version=2024-01-01', {
      resolvedAddresses: ['93.184.216.34'],
    });

    expect(result).toMatchObject({
      normalizedUrl: 'https://xn--bcher-kva.example/models?api-version=2024-01-01',
      hostname: 'xn--bcher-kva.example',
      locality: 'public',
      scope: 'account',
    });
  });

  it.each([
    ['ftp://models.example.test/v1', 'unsupported_scheme'],
    ['https://user:secret@models.example.test/v1', 'userinfo_forbidden'],
    ['https://models.example.test/v1#secret', 'fragment_forbidden'],
    ['https://models.example.test/\nmodels', 'control_character'],
    ['http://models.example.test/v1', 'http_public_forbidden'],
    ['http://169.254.169.254/latest/meta-data', 'unsafe_address'],
    ['http://100.100.100.200/latest/meta-data', 'unsafe_address'],
    ['http://0.0.0.0:11434', 'unsafe_address'],
    ['http://224.0.0.1:11434', 'unsafe_address'],
  ])('rejects unsafe endpoint %s', (rawUrl, code) => {
    expect(() => assessProviderEndpoint(rawUrl, {
      resolvedAddresses: rawUrl.includes('models.example.test') ? ['93.184.216.34'] : undefined,
    })).toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    'https://models.example.test/v1?api_key=secret',
    'https://models.example.test/v1?access-token=secret',
    'https://models.example.test/v1?credential=secret',
  ])('rejects credential-bearing base URL query %s', (rawUrl) => {
    expect(() => assessProviderEndpoint(rawUrl, {
      resolvedAddresses: ['93.184.216.34'],
    })).toThrowError(expect.objectContaining({ code: 'secret_in_url' }));
  });

  it.each([
    'http://127.1:11434',
    'http://0177.0.0.1:11434',
    'http://0x7f000001:11434',
    'http://2130706433:11434',
  ])('rejects non-canonical IPv4 spelling %s', (rawUrl) => {
    expect(() => assessProviderEndpoint(rawUrl)).toThrowError(
      expect.objectContaining({ code: 'odd_ip_encoding' }),
    );
  });

  it('allows loopback HTTP and treats IPv4-mapped loopback IPv6 as loopback', () => {
    expect(assessProviderEndpoint('http://localhost:11434/api/tags', {
      resolvedAddresses: ['127.0.0.1'],
    })).toMatchObject({
      locality: 'loopback',
      scope: 'machine',
    });
    expect(assessProviderEndpoint('http://[::ffff:127.0.0.1]:11434/api/tags')).toMatchObject({
      locality: 'loopback',
      scope: 'machine',
    });
  });

  it('requires explicit confirmation for private HTTP and permits confirmed ULA/private endpoints', () => {
    expect(() => assessProviderEndpoint('http://192.168.1.20:1234/v1')).toThrowError(
      expect.objectContaining({ code: 'http_private_confirmation_required' }),
    );
    expect(assessProviderEndpoint('http://192.168.1.20:1234/v1', { privateNetworkConfirmed: true })).toMatchObject({
      locality: 'private',
      scope: 'machine',
    });
    expect(assessProviderEndpoint('http://[fd12:3456::20]:1234/v1', { privateNetworkConfirmed: true })).toMatchObject({
      locality: 'private',
      scope: 'machine',
    });
    expect(() => assessProviderEndpoint('http://[fe80::1]:11434/v1')).toThrowError(
      expect.objectContaining({ code: 'http_private_confirmation_required' }),
    );
    expect(assessProviderEndpoint('http://[fe80::1]:11434/v1', { privateNetworkConfirmed: true })).toMatchObject({
      locality: 'private',
      scope: 'machine',
    });
  });

  it('classifies a public hostname with private answers as machine-scoped and rejects any unsafe answer', () => {
    const mixed = assessProviderEndpoint('https://gateway.example.test/v1', {
      resolvedAddresses: ['93.184.216.34', '10.0.0.8', 'fd12::8', '10.0.0.8'],
    });
    expect(mixed).toMatchObject({ locality: 'private', scope: 'machine' });
    expect(mixed.resolvedAddresses).toEqual(['10.0.0.8', '93.184.216.34', 'fd12::8']);
    expect(mixed.nonPublicAddresses).toEqual(['10.0.0.8', 'fd12::8']);

    expect(() => assessProviderEndpoint('https://gateway.example.test/v1', {
      resolvedAddresses: ['93.184.216.34', '169.254.169.254'],
    })).toThrowError(expect.objectContaining({ code: 'unsafe_address' }));
  });

  it('requires DNS evidence for non-local hostname authorization', () => {
    expect(() => assessProviderEndpoint('https://gateway.example.test/v1')).toThrowError(
      expect.objectContaining({ code: 'dns_resolution_required' }),
    );
    expect(() => assessProviderEndpoint('https://gateway.example.test/v1', { resolvedAddresses: [] })).toThrowError(
      expect.objectContaining({ code: 'dns_resolution_required' }),
    );
  });

  it('builds an order-stable DNS set inside each ordered endpoint fingerprint input', () => {
    const first = assessProviderEndpoint('https://gateway.example.test/v1', {
      resolvedAddresses: ['fd12::8', '10.0.0.8'],
    });
    const second = assessProviderEndpoint('https://gateway.example.test/v1', {
      resolvedAddresses: ['10.0.0.8', 'fd12:0:0:0:0:0:0:8', '10.0.0.8'],
    });

    expect(buildProviderEndpointSetFingerprintInput([
      { endpointTemplateId: 'gateway', endpoint: first },
    ])).toEqual(buildProviderEndpointSetFingerprintInput([
      { endpointTemplateId: 'gateway', endpoint: second },
    ]));
    expect(buildProviderEndpointSetFingerprintInput([
      { endpointTemplateId: 'a', endpoint: first },
      { endpointTemplateId: 'b', endpoint: first },
    ])).not.toEqual(buildProviderEndpointSetFingerprintInput([
      { endpointTemplateId: 'b', endpoint: first },
      { endpointTemplateId: 'a', endpoint: first },
    ]));
    const changed = assessProviderEndpoint('https://gateway.example.test/v1', {
      resolvedAddresses: ['10.0.0.9', 'fd12::8'],
    });
    expect(buildProviderEndpointSetFingerprintInput([
      { endpointTemplateId: 'gateway', endpoint: first },
    ])).not.toEqual(buildProviderEndpointSetFingerprintInput([
      { endpointTemplateId: 'gateway', endpoint: changed },
    ]));
  });

  it('revalidates redirects and strips credentials across an origin change', () => {
    const from = assessProviderEndpoint('https://gateway.example.test/v1', {
      resolvedAddresses: ['93.184.216.34'],
    });
    const sameOrigin = evaluateProviderRedirect({
      from,
      location: '/v1/models',
      resolvedAddresses: ['93.184.216.34'],
      requestCarriesCredential: true,
    });
    expect(sameOrigin).toMatchObject({
      authorizationRevalidationRequired: true,
      credentialDisposition: 'reauthorize-before-forward',
    });

    const crossOrigin = evaluateProviderRedirect({
      from,
      location: 'https://catalog.example.test/v1/models',
      resolvedAddresses: ['1.1.1.1'],
      requestCarriesCredential: true,
    });
    expect(crossOrigin).toMatchObject({
      authorizationRevalidationRequired: true,
      credentialDisposition: 'strip',
    });

    expect(() => evaluateProviderRedirect({
      from,
      location: 'http://169.254.169.254/latest/meta-data',
      requestCarriesCredential: true,
    })).toThrowError(ProviderEndpointSafetyError);
  });
});
