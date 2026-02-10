import { describe, expect, it } from 'vitest';

describe('libsodium web shim package exports', () => {
  it('loads via the package root (no deep dist path imports)', async () => {
    const mod = await import('./libsodium.lib.web');
    expect(mod.default).toBeDefined();
  });
});
