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

    const expectedPlatforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];
    const expectedExecutableSubpaths = {
      'darwin-arm64': 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'darwin-x64': 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'linux-x64': 'chrome-linux64/chrome',
      'linux-arm64': 'chrome-linux-arm64/chrome',
      'win32-x64': 'chrome-win64/chrome.exe',
    } as const;
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
      expect(asset.executableSubpath).toBe(
        expectedExecutableSubpaths[platform as keyof typeof expectedExecutableSubpaths],
      );
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

    const source = mod.CHROMIUM_FOR_TESTING_PRODUCT_SOURCE;
    expect(mod.ChromiumForTestingProductSourceV1Schema.safeParse(source).success).toBe(true);
    expect(mod.ChromiumForTestingProductSourceV1Schema.safeParse({
      ...source,
      pinnedVersion: 'latest',
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
    expect(mod.resolveChromiumForTestingPlatform('linux', 'arm64')).toBe('linux-arm64');
    expect(mod.resolveChromiumForTestingPlatform('freebsd', 'x64')).toBeNull();
  });

  it('pins the upstream stable Linux ARM64 artifact without upgrading existing platform pins', async () => {
    const mod = await import('./chromiumForTesting.js');
    const source = mod.CHROMIUM_FOR_TESTING_PRODUCT_SOURCE;
    const arm = source.assetsByPlatform['linux-arm64'];
    expect(arm).toMatchObject({
      pinnedVersion: '154.0.8037.92',
      archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/154.0.8037.92/linux-arm64/chrome-linux-arm64.zip',
      integrityDigest: 'sha256:c0af361aab66b24c72e36a4326dce4d7edf4bc23f9aede8af988c2cb6ea3fec0',
      executableSubpath: 'chrome-linux-arm64/chrome',
    });
    expect(source.pinnedVersion).toBe('127.0.6533.88');
    for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
      expect(source.assetsByPlatform[platform].archiveUrl).toContain('/127.0.6533.88/');
    }
  });
});
