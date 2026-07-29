import { describe, expect, it } from 'vitest';

async function loadDirectPeerUrlsModule() {
  return await import(new URL('./directPeerUrls.js', import.meta.url).href).catch((error) => ({ error } as const));
}

describe('direct peer URL normalization', () => {
  it('accepts only HTTPS or loopback HTTP direct transfer candidates', async () => {
    const mod = await loadDirectPeerUrlsModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(mod.isSafeDirectTransferEndpointCandidate({
      kind: 'https',
      url: 'https://machine.example.test/machine-transfers/direct/transfer-1',
      expiresAt: 1,
    })).toBe(true);
    expect(mod.isSafeDirectTransferEndpointCandidate({
      kind: 'http',
      url: 'http://localhost:46001/machine-transfers/direct/transfer-1',
      expiresAt: 1,
    })).toBe(true);
    expect(mod.isSafeDirectTransferEndpointCandidate({
      kind: 'http',
      url: 'http://127.42.0.9:46001/machine-transfers/direct/transfer-1',
      expiresAt: 1,
    })).toBe(true);
    expect(mod.isSafeDirectTransferEndpointCandidate({
      kind: 'http',
      url: 'http://[::1]:46001/machine-transfers/direct/transfer-1',
      expiresAt: 1,
    })).toBe(true);
    expect(mod.isSafeDirectTransferEndpointCandidate({
      kind: 'http',
      url: 'http://192.168.1.20:46001/machine-transfers/direct/transfer-1',
      authorizationToken: 'remote-dev-shaped-token',
      expiresAt: 1,
    })).toBe(false);
    expect(mod.isSafeDirectTransferEndpointCandidate(null)).toBe(false);
  });

  it('normalizes direct peer transfer base URLs with an optional path prefix', async () => {
    const mod = await loadDirectPeerUrlsModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(mod.normalizeDirectPeerTransferEndpointBaseUrl(
      'https://user:pass@example.com/__happier/transfer/machine-transfers/direct/abc?token=leak#frag',
    )).toBe('https://example.com/__happier/transfer/machine-transfers/direct/abc');
  });

  it('rejects direct peer transfer URLs that do not end at /machine-transfers/direct/<transferKey>', async () => {
    const mod = await loadDirectPeerUrlsModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(() => mod.normalizeDirectPeerTransferEndpointBaseUrl(
      'https://example.com/__happier/transfer/machine-transfers/direct/abc/open',
    )).toThrow('Invalid direct peer endpoint candidate');
  });

  it('normalizes direct import session base URLs with an optional path prefix', async () => {
    const mod = await loadDirectPeerUrlsModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(mod.normalizeDirectPeerImportEndpointBaseUrl(
      'https://example.com/__happier/transfer/machine-transfers/direct/imports/upload-1?bad=ignored',
    )).toBe('https://example.com/__happier/transfer/machine-transfers/direct/imports/upload-1');
  });
});
