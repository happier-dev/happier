import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveExecutableMock } = vi.hoisted(() => ({
  resolveExecutableMock: vi.fn(),
}));

vi.mock('@/packagedRuntime/installables/sourceAdapters/chromiumForTesting', () => ({
  resolveInstalledChromiumForTestingExecutable: resolveExecutableMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('managed browser sidecar product source resolver', () => {
  it('maps an installed managed Chromium artifact into a provenance-bearing candidate', async () => {
    const mod = await import('./source');

    expect(mod?.resolveManagedBrowserSidecarCandidate).toBeTypeOf('function');
    if (!mod?.resolveManagedBrowserSidecarCandidate) return;

    resolveExecutableMock.mockResolvedValue('/home/u/.happier/tools/browser-chromium/current/chrome');

    const candidate = await mod.resolveManagedBrowserSidecarCandidate({
      platform: 'linux',
      arch: 'x64',
      // Inject a verified digest to simulate a recorded external artifact.
      assetOverride: {
        archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/linux64/chrome-linux64.zip',
        integrityDigest: `sha256:${'c'.repeat(64)}`,
        executableSubpath: 'chrome',
      },
    });

    expect(candidate).not.toBeNull();
    if (!candidate) return;
    expect(candidate).toMatchObject({
      source: 'managedBrowserPackage',
      discoveryKind: 'managedRuntime',
      available: true,
      executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
    });
    expect(candidate.provenance).toMatchObject({
      origin: 'managed_package',
      channel: 'stable',
      integrityDigest: `sha256:${'c'.repeat(64)}`,
    });
    expect(candidate.provenance?.pinnedVersion).toMatch(/^[0-9]+(?:\.[0-9]+){3}$/);
  });

  it('returns an unavailable candidate when no managed artifact is installed', async () => {
    const mod = await import('./source');

    expect(mod?.resolveManagedBrowserSidecarCandidate).toBeTypeOf('function');
    if (!mod?.resolveManagedBrowserSidecarCandidate) return;

    resolveExecutableMock.mockResolvedValue(null);

    const candidate = await mod.resolveManagedBrowserSidecarCandidate({
      platform: 'linux',
      arch: 'x64',
      assetOverride: {
        archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/linux64/chrome-linux64.zip',
        integrityDigest: `sha256:${'c'.repeat(64)}`,
        executableSubpath: 'chrome',
      },
    });

    expect(candidate).toMatchObject({
      source: 'managedBrowserPackage',
      discoveryKind: 'managedRuntime',
      available: false,
    });
    expect(candidate?.provenance).toBeUndefined();
  });

  it('fails closed (no candidate) when the pinned asset has no verified digest', async () => {
    const mod = await import('./source');

    expect(mod?.resolveManagedBrowserSidecarCandidate).toBeTypeOf('function');
    if (!mod?.resolveManagedBrowserSidecarCandidate) return;

    resolveExecutableMock.mockResolvedValue('/home/u/.happier/tools/browser-chromium/current/chrome');

    const candidate = await mod.resolveManagedBrowserSidecarCandidate({
      platform: 'linux',
      arch: 'x64',
      assetOverride: {
        archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/linux64/chrome-linux64.zip',
        integrityDigest: null,
        executableSubpath: 'chrome',
      },
    });

    expect(candidate).toBeNull();
  });

  it('fails closed (no candidate) on an unsupported platform', async () => {
    const mod = await import('./source');

    expect(mod?.resolveManagedBrowserSidecarCandidate).toBeTypeOf('function');
    if (!mod?.resolveManagedBrowserSidecarCandidate) return;

    const candidate = await mod.resolveManagedBrowserSidecarCandidate({
      platform: 'freebsd',
      arch: 'x64',
    });

    expect(candidate).toBeNull();
    expect(resolveExecutableMock).not.toHaveBeenCalled();
  });
});
