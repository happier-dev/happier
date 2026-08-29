import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  redactPeerMediationObservabilityHeaders,
  redactPeerMediationObservabilityMetadata,
  redactPeerMediationObservabilityUrl,
  redactedPeerMediationObservabilityReference,
} from './metadataRedaction.js';

describe('peer mediation observability shared redactor (DUP-3 single owner)', () => {
  it('keeps safe header context while dropping credential and identity spellings', () => {
    const out = redactPeerMediationObservabilityHeaders({
      authorization: 'Bearer secret',
      'sec-websocket-protocol': 'base64url.bearer.authorization.k8s.io.tok',
      'x-user-id': 'user-secret',
      'chatgpt-account-id': 'account-secret',
      'content-type': 'application/json',
      'x-request-id': 'r1',
      'X-Tenant-Label': 'workspace-alpha',
    });
    expect(out).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'r1',
      'x-tenant-label': 'workspace-alpha',
    });
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('bearer');
    expect(JSON.stringify(out)).not.toContain('user-secret');
    expect(JSON.stringify(out)).not.toContain('account-secret');
  });

  it('strips token-bearing query values, keeping only safe key names, honoring the url base', () => {
    const out = redactPeerMediationObservabilityUrl('/path?token=secret&page=2', 'http://loopback.invalid');
    expect(out.path).toBe('/path');
    expect(out.queryKeys).toEqual(['page']);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('recursively redacts metadata (url/headers/nested) and removes unsafe keys', () => {
    const out = redactPeerMediationObservabilityMetadata(
      {
        url: 'https://api.test/v1?api_key=k',
        headers: { authorization: 'Bearer t', accept: 'application/json' },
        token: 'should-be-dropped',
        nested: { cookie: 'session=x', region: 'eu' },
      },
      { urlBase: 'http://preview.invalid' },
    );
    expect(out).not.toHaveProperty('token');
    expect((out.nested as Record<string, unknown>)).not.toHaveProperty('cookie');
    expect((out.nested as Record<string, unknown>).region).toBe('eu');
    expect(JSON.stringify(out)).not.toContain('Bearer');
    expect(JSON.stringify(out)).not.toContain('api_key=k');
  });

  it('produces a stable hashed reference and passes through undefined', () => {
    expect(redactedPeerMediationObservabilityReference('grant', undefined)).toBeUndefined();
    const a = redactedPeerMediationObservabilityReference('grant', 'abc');
    const b = redactedPeerMediationObservabilityReference('grant', 'abc');
    expect(a).toBe(b);
    expect(a).toBe('grant_ba7816bf8f01');
    expect(a).toMatch(/^grant_[0-9a-f]{12}$/);
    expect(a).not.toContain('abc');
  });

  it('keeps the shared redactor browser-portable for Protocol root consumers', async () => {
    const source = await readFile(new URL('./metadataRedaction.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('node:crypto');
    expect(source).toContain("from '@noble/hashes/sha2'");
    expect(source).toContain("from '@noble/hashes/utils'");
  });
});
