import { describe, expect, it } from 'vitest';

describe('chromium-for-testing pinned product source descriptor', () => {
  it('pins an exact CfT build and a known channel/license', async () => {
    const mod = await import('./chromiumForTesting.js').catch(() => null);

    expect(mod?.CHROMIUM_FOR_TESTING_PRODUCT_SOURCE).toBeDefined();
    if (!mod?.CHROMIUM_FOR_TESTING_PRODUCT_SOURCE) return;

    const source = mod.CHROMIUM_FOR_TESTING_PRODUCT_SOURCE;
    expect(source.key).toBe('browser-chromium');
    expect(source.pinnedVersion).toMatch(/^[0-9]+(?:\.[0-9]+){3}$/);
    expect(source.channel).toBe('stable');
    expect(source.license.length).toBeGreaterThan(0);
  });

  it('pins a real verified sha256 digest for every supported platform (MCH-1: build-now, not deferred)', async () => {
    const mod = await import('./chromiumForTesting.js').catch(() => null);

    expect(mod?.CHROMIUM_FOR_TESTING_PRODUCT_SOURCE).toBeDefined();
    if (!mod?.CHROMIUM_FOR_TESTING_PRODUCT_SOURCE) return;

    const expectedPlatforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
    const assetsByPlatform = mod.CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.assetsByPlatform;
    expect(Object.keys(assetsByPlatform).sort()).toEqual([...expectedPlatforms].sort());

    for (const platform of expectedPlatforms) {
      const asset = assetsByPlatform[platform];
      expect(asset, `missing asset for ${platform}`).toBeDefined();
      if (!asset) continue;
      expect(asset.archiveUrl.startsWith('https://')).toBe(true);
      // BUILD-NOW (MCH-1): a real sha256 of the pinned build's archive bytes is recorded so the
      // source resolver can promote the artifact. No platform stays null/fail-closed.
      expect(asset.integrityDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(asset.executableSubpath.startsWith('/')).toBe(false);
    }
  });

  it('keeps the schema able to fail closed for an un-digested future build', async () => {
    const mod = await import('./chromiumForTesting.js').catch(() => null);

    expect(mod?.ChromiumForTestingPlatformAssetSchema).toBeDefined();
    if (!mod?.ChromiumForTestingPlatformAssetSchema) return;

    // The schema still permits null so an un-digested future build fails closed by construction.
    expect(mod.ChromiumForTestingPlatformAssetSchema.safeParse({
      archiveUrl: 'https://storage.googleapis.com/x/chrome.zip',
      integrityDigest: null,
      executableSubpath: 'chrome',
    }).success).toBe(true);
  });

  it('rejects a non-immutable (latest-style) pinned version', async () => {
    const mod = await import('./chromiumForTesting.js').catch(() => null);

    expect(mod?.ChromiumForTestingProductSourceV1Schema).toBeDefined();
    if (!mod?.ChromiumForTestingProductSourceV1Schema) return;

    expect(mod.ChromiumForTestingProductSourceV1Schema.safeParse({
      key: 'browser-chromium',
      pinnedVersion: 'latest',
      channel: 'stable',
      license: 'BSD-3-Clause',
      assetsByPlatform: {},
    }).success).toBe(false);
  });

  it('rejects a non-sha256 integrity digest', async () => {
    const mod = await import('./chromiumForTesting.js').catch(() => null);

    expect(mod?.ChromiumForTestingPlatformAssetSchema).toBeDefined();
    if (!mod?.ChromiumForTestingPlatformAssetSchema) return;

    expect(mod.ChromiumForTestingPlatformAssetSchema.safeParse({
      archiveUrl: 'https://storage.googleapis.com/x/chrome.zip',
      integrityDigest: 'deadbeef',
      executableSubpath: 'chrome',
    }).success).toBe(false);
  });

  it('maps node platform/arch pairs to CfT platform keys', async () => {
    const mod = await import('./chromiumForTesting.js').catch(() => null);

    expect(mod?.resolveChromiumForTestingPlatform).toBeTypeOf('function');
    if (!mod?.resolveChromiumForTestingPlatform) return;

    expect(mod.resolveChromiumForTestingPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(mod.resolveChromiumForTestingPlatform('linux', 'x64')).toBe('linux-x64');
    expect(mod.resolveChromiumForTestingPlatform('win32', 'x64')).toBe('win32-x64');
    expect(mod.resolveChromiumForTestingPlatform('linux', 'arm64')).toBeNull();
    expect(mod.resolveChromiumForTestingPlatform('freebsd', 'x64')).toBeNull();
  });
});
