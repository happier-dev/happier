import { describe, expect, it } from 'vitest';

import {
  managedServiceEndpointHostPolicyForMode,
  readManagedServiceEndpointUrl,
} from './managedServiceEndpointUrl.js';

describe('readManagedServiceEndpointUrl', () => {
  it('accepts HTTPS at any valid host but keeps HTTP attach endpoints on normalized loopback only', () => {
    expect(readManagedServiceEndpointUrl('https://OpenCode.Example.com:443/path', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'https://opencode.example.com/path', host: 'opencode.example.com', port: 443 },
    });
    expect(readManagedServiceEndpointUrl('http://LOCALHOST:4096', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'http://localhost:4096', host: 'localhost', port: 4096 },
    });
    expect(readManagedServiceEndpointUrl('http://127.0.0.1:4096', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'http://127.0.0.1:4096', host: '127.0.0.1', port: 4096 },
    });
    expect(readManagedServiceEndpointUrl('http://[::1]:4096', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'http://[::1]:4096', host: '::1', port: 4096 },
    });
    expect(readManagedServiceEndpointUrl('http://192.168.1.50:4096', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({ ok: false, rejection: 'host' });
    expect(readManagedServiceEndpointUrl('http://opencode.lan:9999', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({ ok: false, rejection: 'host' });
  });

  /**
   * A scheme-default port has to follow the scheme. Defaulting an `https:` URL
   * to 80 makes the endpoint compare unequal to its own health target.
   */
  it('resolves the scheme default port rather than assuming http', () => {
    expect(readManagedServiceEndpointUrl('https://opencode.example.com', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'https://opencode.example.com', host: 'opencode.example.com', port: 443 },
    });

    expect(readManagedServiceEndpointUrl('http://localhost', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'http://localhost', host: 'localhost', port: 80 },
    });
  });

  it('rejects a URL carrying credentials under every policy', () => {
    for (const hostPolicy of ['ownedLoopback', 'userDeclaredAttach'] as const) {
      expect(readManagedServiceEndpointUrl('http://opencode:secret@127.0.0.1:4096', {
        hostPolicy,
      })).toEqual({ ok: false, rejection: 'embeddedCredentials' });
    }
    expect(readManagedServiceEndpointUrl('https://opencode:secret@example.com', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({ ok: false, rejection: 'embeddedCredentials' });
  });

  it('keeps an owned loopback endpoint pinned to plain-http loopback', () => {
    expect(readManagedServiceEndpointUrl('http://192.168.1.50:4096', {
      hostPolicy: 'ownedLoopback',
    })).toEqual({ ok: false, rejection: 'host' });
    expect(readManagedServiceEndpointUrl('http://0.0.0.0:4096', {
      hostPolicy: 'ownedLoopback',
    })).toEqual({ ok: false, rejection: 'host' });
    expect(readManagedServiceEndpointUrl('https://127.0.0.1:4096', {
      hostPolicy: 'ownedLoopback',
    })).toEqual({ ok: false, rejection: 'scheme' });
    expect(readManagedServiceEndpointUrl('http://[::1]:4096', {
      hostPolicy: 'ownedLoopback',
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'http://[::1]:4096', host: '::1', port: 4096 },
    });
    expect(readManagedServiceEndpointUrl('http://localhost:4096', {
      hostPolicy: 'ownedLoopback',
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'http://localhost:4096', host: 'localhost', port: 4096 },
    });
  });

  it('rejects unsupported schemes, stray query or fragment, and malformed input', () => {
    expect(readManagedServiceEndpointUrl('ftp://example.com', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({ ok: false, rejection: 'scheme' });
    expect(readManagedServiceEndpointUrl('http://example.com?token=leak', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({ ok: false, rejection: 'queryOrFragment' });
    expect(readManagedServiceEndpointUrl('http://example.com#leak', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({ ok: false, rejection: 'queryOrFragment' });
    expect(readManagedServiceEndpointUrl('not a url', {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({ ok: false, rejection: 'malformed' });
    expect(readManagedServiceEndpointUrl(42, {
      hostPolicy: 'userDeclaredAttach',
    })).toEqual({ ok: false, rejection: 'malformed' });
  });

  it('admits a query or fragment only when the caller allows it', () => {
    expect(readManagedServiceEndpointUrl('http://127.0.0.1:4096/health?probe=1', {
      hostPolicy: 'ownedLoopback',
      allowSearch: true,
    })).toEqual({
      ok: true,
      endpoint: { baseUrl: 'http://127.0.0.1:4096/health?probe=1', host: '127.0.0.1', port: 4096 },
    });
  });
});

describe('managedServiceEndpointHostPolicyForMode', () => {
  it('maps attach modes to the user-declared policy and spawn modes to loopback', () => {
    expect(managedServiceEndpointHostPolicyForMode('attach')).toBe('userDeclaredAttach');
    expect(managedServiceEndpointHostPolicyForMode('externalAttach')).toBe('userDeclaredAttach');
    expect(managedServiceEndpointHostPolicyForMode('spawn')).toBe('ownedLoopback');
    expect(managedServiceEndpointHostPolicyForMode('managedSpawn')).toBe('ownedLoopback');
  });
});
