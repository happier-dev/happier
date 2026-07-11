import { describe, expect, it } from 'vitest';

import {
  redactPeerMediationObservabilityHeaders,
  redactPeerMediationObservabilityMetadata,
  redactPeerMediationObservabilityUrl,
  redactedPeerMediationObservabilityReference,
} from './metadataRedaction.js';

describe('peer mediation observability shared redactor (DUP-3 single owner)', () => {
  it('drops all but the safe header allowlist and never surfaces the WS subprotocol', () => {
    const out = redactPeerMediationObservabilityHeaders({
      authorization: 'Bearer secret',
      'sec-websocket-protocol': 'base64url.bearer.authorization.k8s.io.tok',
      'content-type': 'application/json',
      'x-request-id': 'r1',
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'x-request-id': 'r1' });
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('bearer');
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
    expect(a).toMatch(/^grant_[0-9a-f]{12}$/);
    expect(a).not.toContain('abc');
  });
});
