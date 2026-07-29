import type { Stats } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ManagedProviderEndpointDeclarationV1 } from '@/providers/managed/types';

import { resolveManagedProviderRuntimeLaunch } from './resolveManagedProviderRuntimeLaunch';

const declaration = {
  id: 'managed-provider',
  launch: {
    kind: 'packaged-runtime-binary',
    directorySegments: ['tools', 'unpacked'],
    executableBaseName: 'happier-cliproxyapi-managed',
    privateConfigPathFlag: '--config',
  },
  launchMode: {
    kind: 'assignAndInject',
    portPolicy: { kind: 'allocated' },
    environment: { inject: ['PORT', 'HOST'] },
  },
  hostPolicy: { kind: 'loopback', host: '127.0.0.1' },
  name: { strategy: 'fixed', name: 'Managed Provider' },
  healthCheck: { kind: 'http', path: '/healthz' },
  restart: { kind: 'never' },
  cleanup: { staleAfterMs: 60_000 },
} as const satisfies ManagedProviderEndpointDeclarationV1['localService'];

function regularFile(mode = 0o100755): Stats {
  return {
    isFile: () => true,
    mode,
  } as Stats;
}

describe('managed Provider packaged runtime launch resolution', () => {
  it.each([
    ['darwin', 'happier-cliproxyapi-managed'],
    ['linux', 'happier-cliproxyapi-managed'],
    ['win32', 'happier-cliproxyapi-managed.exe'],
  ] as const)('resolves the exact staged %s asset to an ordinary binary launch', async (
    platform,
    executableName,
  ) => {
    const resolveAssetPath = vi.fn((...segments: string[]) => (
      `/opt/happier/${segments.join('/')}`
    ));
    const statFile = vi.fn(async () => regularFile());

    await expect(resolveManagedProviderRuntimeLaunch(
      declaration,
      {
        materializedRootDir: '/private/runtime',
        privateConfigPath: '/private/runtime/config.json',
      },
      { platform, resolveAssetPath, statFile },
    )).resolves.toEqual({
      ...declaration,
      launch: {
        kind: 'binary',
        executablePath: `/opt/happier/tools/unpacked/${executableName}`,
        args: ['--config', '/private/runtime/config.json'],
      },
    });
    expect(resolveAssetPath).toHaveBeenCalledWith('tools', 'unpacked', executableName);
    expect(statFile).toHaveBeenCalledWith(
      `/opt/happier/tools/unpacked/${executableName}`,
    );
  });

  it('rejects missing, non-file, non-executable, wrong-name, and unsupported-platform assets', async () => {
    const cases = [
      {
        platform: 'linux' as const,
        resolveAssetPath: () => '/opt/happier/tools/unpacked/wrong-name',
        statFile: async () => regularFile(),
      },
      {
        platform: 'linux' as const,
        resolveAssetPath: () => '/opt/happier/tools/unpacked/happier-cliproxyapi-managed',
        statFile: async () => regularFile(0o100644),
      },
      {
        platform: 'linux' as const,
        resolveAssetPath: () => '/opt/happier/tools/unpacked/happier-cliproxyapi-managed',
        statFile: async () => ({ isFile: () => false, mode: 0o100755 } as Stats),
      },
      {
        platform: 'linux' as const,
        resolveAssetPath: () => '/opt/happier/tools/unpacked/happier-cliproxyapi-managed',
        statFile: async (): Promise<Stats> => {
          throw new Error('missing');
        },
      },
      {
        platform: 'freebsd' as const,
        resolveAssetPath: () => '/not-reached',
        statFile: async () => regularFile(),
      },
    ];

    for (const current of cases) {
      await expect(resolveManagedProviderRuntimeLaunch(
        declaration,
        {
          materializedRootDir: '/private/runtime',
          privateConfigPath: '/private/runtime/config.json',
        },
        current,
      )).resolves.toBeNull();
    }
  });

  it.each([
    'relative/config.json',
    '/private/runtime',
    '/private/runtime-sibling/config.json',
  ])('rejects a config path outside the daemon-owned materialization root: %s', async (
    privateConfigPath,
  ) => {
    await expect(resolveManagedProviderRuntimeLaunch(
      declaration,
      {
        materializedRootDir: '/private/runtime',
        privateConfigPath,
      },
      {
        platform: 'linux',
        resolveAssetPath: (...segments) => `/opt/happier/${segments.join('/')}`,
        statFile: async () => regularFile(),
      },
    )).resolves.toBeNull();
  });

  it.each([
    { directorySegments: ['..'] },
    { executableBaseName: '../other-runtime' },
    { privateConfigPathFlag: '--config;run' },
  ])('rejects a forged packaged-runtime declaration before resolving an asset: %o', async (
    launchOverride,
  ) => {
    const resolveAssetPath = vi.fn(() => (
      '/opt/happier/tools/unpacked/happier-cliproxyapi-managed'
    ));
    await expect(resolveManagedProviderRuntimeLaunch(
      {
        ...declaration,
        launch: {
          ...declaration.launch,
          ...launchOverride,
        },
      } as ManagedProviderEndpointDeclarationV1['localService'],
      {
        materializedRootDir: '/private/runtime',
        privateConfigPath: '/private/runtime/config.json',
      },
      {
        platform: 'linux',
        resolveAssetPath,
        statFile: async () => regularFile(),
      },
    )).resolves.toBeNull();
    expect(resolveAssetPath).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a same-named symlink instead of following it as a packaged executable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'happier-managed-runtime-asset-'));
      try {
        const target = join(root, 'outside-runtime');
        const executablePath = join(root, 'happier-cliproxyapi-managed');
        await writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        await symlink(target, executablePath);

        await expect(resolveManagedProviderRuntimeLaunch(
          declaration,
          {
            materializedRootDir: '/private/runtime',
            privateConfigPath: '/private/runtime/config.json',
          },
          {
            platform: 'linux',
            resolveAssetPath: () => executablePath,
          },
        )).resolves.toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
