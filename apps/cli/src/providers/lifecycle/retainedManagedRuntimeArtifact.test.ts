import { describe, expect, it, vi } from 'vitest';

import { verifyRetainedManagedProviderRuntimeArtifact } from './retainedManagedRuntimeArtifact';

const declaration = {
  id: 'cliproxyapi',
  launch: {
    kind: 'packaged-runtime-binary' as const,
    directorySegments: ['tools', 'unpacked'],
    executableBaseName: 'happier-cliproxyapi-managed',
    privateConfigPathFlag: '--private-config',
  },
  launchMode: {
    kind: 'assignAndInject' as const,
    portPolicy: { kind: 'allocated' as const },
    environment: { inject: ['PORT' as const, 'HOST' as const] },
  },
  hostPolicy: { kind: 'loopback' as const },
  name: { strategy: 'derived' as const, base: 'CLIProxyAPI' },
  healthCheck: { kind: 'http' as const, path: '/healthz' },
  restart: { kind: 'never' as const },
  cleanup: { staleAfterMs: 30_000 },
};

describe('retained managed runtime artifact verification', () => {
  it.each([
    ['darwin', '/home/.happier/cli/versions/A/tools/unpacked/happier-cliproxyapi-managed'],
    ['linux', '/home/.happier/cli/versions/A/tools/unpacked/happier-cliproxyapi-managed'],
    ['win32', 'C:\\home\\.happier\\cli\\versions\\A\\tools\\unpacked\\happier-cliproxyapi-managed.exe'],
  ] as const)('accepts retained A after current advances to B on %s', async (platform, observedPath) => {
    const versionRoot = platform === 'win32'
      ? 'C:\\home\\.happier\\cli\\versions\\A'
      : '/home/.happier/cli/versions/A';
    const expectedPath = platform === 'win32'
      ? `${versionRoot}\\tools\\unpacked\\happier-cliproxyapi-managed.exe`
      : `${versionRoot}/tools/unpacked/happier-cliproxyapi-managed`;
    await expect(verifyRetainedManagedProviderRuntimeArtifact({
      wrapperBuildVersion: 'A',
      observedExecutablePath: observedPath,
      declaration,
    }, {
      platform,
      resolveReleaseChannel: vi.fn(async () => ({ ringId: 'stable' as const })),
      resolveInstallLayout: vi.fn(() => ({
        componentId: 'happier-cli' as const,
        channel: 'stable' as const,
        installRootName: 'cli',
        installShims: ['happier'],
        happyHomeDir: '/home/.happier',
        installRoot: '/home/.happier/cli',
        versionsDir: '/home/.happier/cli/versions',
        currentPath: '/home/.happier/cli/current',
        previousPath: '/home/.happier/cli/previous',
        shimDir: '/home/.happier/bin',
      })),
      readVersionMarkers: vi.fn(async () => ({
        currentVersionId: 'B',
        previousVersionId: 'A',
      })),
      resolveVersionInstallPath: vi.fn(() => versionRoot),
      statFile: vi.fn(async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o755,
      })),
      resolveRealPath: vi.fn(async (path) => (
        path.replaceAll('/', platform === 'win32' ? '\\' : '/')
          .toLowerCase() === expectedPath.toLowerCase()
          ? observedPath
          : path
      )),
    })).resolves.toBe(true);
  });

  it('rejects an exact-looking artifact when launch-recorded A is no longer retained', async () => {
    await expect(verifyRetainedManagedProviderRuntimeArtifact({
      wrapperBuildVersion: 'A',
      observedExecutablePath:
        '/home/.happier/cli/versions/A/tools/unpacked/happier-cliproxyapi-managed',
      declaration,
    }, {
      platform: 'linux',
      resolveReleaseChannel: vi.fn(async () => ({ ringId: 'stable' as const })),
      resolveInstallLayout: vi.fn(() => ({
        componentId: 'happier-cli' as const,
        channel: 'stable' as const,
        installRootName: 'cli',
        installShims: ['happier'],
        happyHomeDir: '/home/.happier',
        installRoot: '/home/.happier/cli',
        versionsDir: '/home/.happier/cli/versions',
        currentPath: '/home/.happier/cli/current',
        previousPath: '/home/.happier/cli/previous',
        shimDir: '/home/.happier/bin',
      })),
      readVersionMarkers: vi.fn(async () => ({
        currentVersionId: 'B',
        previousVersionId: null,
      })),
    })).resolves.toBe(false);
  });
});
