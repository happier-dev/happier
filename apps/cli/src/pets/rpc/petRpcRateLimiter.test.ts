import { describe, expect, it } from 'vitest';

describe('pet RPC rate limiting', () => {
  it('returns rate_limited when daemon pet RPC debouncing denies a request', async () => {
    const { handleDiscoverPets } = await import('./handleDiscoverPets');
    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const { handleForgetLocalPetPackage } = await import('./handleForgetLocalPetPackage');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const rateLimiter = {
      tryConsume: () => false,
    };

    await expect(handleDiscoverPets({}, { rateLimiter })).resolves.toMatchObject({
      ok: false,
      errorCode: 'rate_limited',
    });
    await expect(handleImportLocalPetPackage({ sourceKey: 'pet:0123456789abcdef0123456789abcdef' }, { rateLimiter })).resolves.toMatchObject({
      ok: false,
      errorCode: 'rate_limited',
    });
    await expect(handleForgetLocalPetPackage({ sourceKey: 'pet:0123456789abcdef0123456789abcdef' }, { rateLimiter })).resolves.toMatchObject({
      ok: false,
      errorCode: 'rate_limited',
    });
    await expect(handleReadPetPreviewAsset({ sourceKey: 'pet:0123456789abcdef0123456789abcdef' }, { rateLimiter })).resolves.toMatchObject({
      ok: false,
      errorCode: 'rate_limited',
    });
  });

  it('debounces repeated requests per pet RPC operation', async () => {
    let nowMs = 1_000;
    const { createPetRpcRateLimiter } = await import('./petRpcRateLimiter');
    const rateLimiter = createPetRpcRateLimiter({
      minIntervalsMs: { readPreviewAsset: 25 },
      nowMs: () => nowMs,
    });

    expect(rateLimiter.tryConsume('readPreviewAsset')).toBe(true);
    expect(rateLimiter.tryConsume('readPreviewAsset')).toBe(false);
    expect(rateLimiter.tryConsume('discoverPackages')).toBe(true);
    nowMs += 25;
    expect(rateLimiter.tryConsume('readPreviewAsset')).toBe(true);
  });
});
