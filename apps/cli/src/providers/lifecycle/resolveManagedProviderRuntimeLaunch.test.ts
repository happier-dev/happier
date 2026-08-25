import { createHash } from 'node:crypto';
import { renameSync, rmSync, symlinkSync, type Stats } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import { describe, expect, it, vi } from 'vitest';

import {
  resolveManagedProviderRuntimeExecutable,
} from './resolveManagedProviderRuntimeLaunch';

function regularFile(mode = 0o100755): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    mode,
  } as Stats;
}

function directory(): Stats {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
  } as Stats;
}

function retainedRuntimePathStats(root: string) {
  return async (path: string): Promise<Stats> => (
    path === root ? directory() : regularFile()
  );
}

const MANAGED_RUNTIME_REF = {
  kind: 'packaged-runtime-binary' as const,
  directorySegments: ['tools', 'unpacked'] as const,
  executableBaseName: 'happier-cliproxyapi-managed',
};

async function writeRuntimeRoot(input: Readonly<{
  runtimeRoot: string;
  executableName?: string;
  executableBytes?: string;
  recordRuntimeAsset?: boolean;
}>): Promise<Readonly<{
  executablePath: string;
  manifestPath: string;
}>> {
  const executableName = input.executableName
    ?? 'happier-cliproxyapi-managed';
  const executableBytes = input.executableBytes ?? '#!/bin/sh\nexit 0\n';
  const entrypoint = join(input.runtimeRoot, 'package-dist', 'index.mjs');
  const executablePath = join(
    input.runtimeRoot,
    'tools',
    'unpacked',
    executableName,
  );
  await mkdir(join(input.runtimeRoot, 'package-dist'), { recursive: true });
  await mkdir(join(input.runtimeRoot, 'tools', 'unpacked'), {
    recursive: true,
  });
  await writeFile(entrypoint, 'export default true;\n');
  await writeFile(executablePath, executableBytes, { mode: 0o755 });
  const { manifestPath } = cliDistBuildManifest.writeCliDistBuildManifest(
    entrypoint,
  );
  if (input.recordRuntimeAsset !== false) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest.runtimeAsset = {
      relativePath: `tools/unpacked/${executableName}`,
      byteLength: Buffer.byteLength(executableBytes),
      sha256: createHash('sha256').update(executableBytes).digest('hex'),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { executablePath, manifestPath };
}

describe('managed Provider packaged runtime launch resolution', () => {
  it('resolves retained version A directly after the installed current pointer advances to B', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retained-version-'));
    const versionARoot = join(root, 'versions', 'A');
    const versionBRoot = join(root, 'versions', 'B');
    try {
      const versionA = await writeRuntimeRoot({
        runtimeRoot: versionARoot,
        executableBytes: '#!/bin/sh\necho A\n',
      });
      const versionB = await writeRuntimeRoot({
        runtimeRoot: versionBRoot,
        executableBytes: '#!/bin/sh\necho B\n',
      });
      const resolveAssetPath = vi.fn(() => versionB.executablePath);

      await expect(resolveManagedProviderRuntimeExecutable(
        MANAGED_RUNTIME_REF,
        {
          platform: 'linux',
          retainedRunnerRuntimeIdentity: 'version:A',
          resolveReleaseChannel: vi.fn(async () => ({
            ringId: 'stable' as const,
          })),
          resolveVersionInstallPath: vi.fn(() => versionARoot),
          resolveAssetPath,
        },
      )).resolves.toBe(await realpath(versionA.executablePath));
      expect(resolveAssetPath).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves and verifies the exact retained snapshot root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retained-snapshot-'));
    const snapshotRoot = join(root, '.runner-snapshots', 'snapshot-a');
    try {
      const snapshot = await writeRuntimeRoot({ runtimeRoot: snapshotRoot });
      await expect(resolveManagedProviderRuntimeExecutable(
        MANAGED_RUNTIME_REF,
        {
          platform: 'linux',
          retainedRunnerRuntimeIdentity: 'snapshot:snapshot-a',
          runtimeModuleUrl: pathToFileURL(join(
            snapshotRoot,
            'package-dist',
            'managed-runtime.mjs',
          )).href,
          resolveRuntimeRootFromModuleUrl: vi.fn(() => snapshotRoot),
        },
      )).resolves.toBe(await realpath(snapshot.executablePath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a valid managed runtime from the current packaged root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-current-runtime-'));
    const runtimeRoot = join(root, 'current');
    try {
      const runtime = await writeRuntimeRoot({ runtimeRoot });
      await expect(resolveManagedProviderRuntimeExecutable(
        MANAGED_RUNTIME_REF,
        {
          platform: 'linux',
          resolveAssetPath: (...segments: string[]) => join(
            runtimeRoot,
            ...segments,
          ),
        },
      )).resolves.toBe(await realpath(runtime.executablePath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a materialized installed plugin-generation runtime without falling back to the CLI payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-installed-plugin-runtime-'));
    const generationRoot = join(root, 'generations', 'provider-p');
    try {
      const runtime = await writeRuntimeRoot({
        runtimeRoot: generationRoot,
        recordRuntimeAsset: false,
      });
      const resolveAssetPath = vi.fn((...segments: string[]) => join(
        root,
        'cli-payload-that-must-not-be-read',
        ...segments,
      ));

      await expect(resolveManagedProviderRuntimeExecutable(
        MANAGED_RUNTIME_REF,
        {
          platform: 'linux',
          installedPluginGenerationRuntimeRoot: generationRoot,
          resolveAssetPath,
        },
      )).resolves.toBe(await realpath(runtime.executablePath));
      expect(resolveAssetPath).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'binds current-root launch to the verified real version across pointer promotion',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'happier-current-runtime-race-'));
      const versionARoot = join(root, 'versions', 'A');
      const versionBRoot = join(root, 'versions', 'B');
      const currentRoot = join(root, 'current');
      try {
        const versionA = await writeRuntimeRoot({
          runtimeRoot: versionARoot,
          executableBytes: '#!/bin/sh\necho A\n',
        });
        await writeRuntimeRoot({
          runtimeRoot: versionBRoot,
          executableBytes: '#!/bin/sh\necho B\n',
        });
        await symlink(versionARoot, currentRoot, 'dir');
        const readIntegrity = cliDistBuildManifest.readCliRuntimeAssetIntegrity;
        const integritySpy = vi.spyOn(
          cliDistBuildManifest,
          'readCliRuntimeAssetIntegrity',
        ).mockImplementation((input) => {
          const result = readIntegrity(input);
          rmSync(currentRoot);
          symlinkSync(versionBRoot, currentRoot, 'dir');
          return result;
        });

        try {
          await expect(resolveManagedProviderRuntimeExecutable(
            MANAGED_RUNTIME_REF,
            {
              platform: 'linux',
              resolveAssetPath: (...segments: string[]) => join(
                currentRoot,
                ...segments,
              ),
            },
          )).resolves.toBe(await realpath(versionA.executablePath));
          await expect(realpath(currentRoot)).resolves.toBe(await realpath(versionBRoot));
          expect(integritySpy).toHaveBeenCalledOnce();
        } finally {
          integritySpy.mockRestore();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'binds a Windows-style physical current copy to current.version before promotion',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'happier-current-copy-race-'));
      const versionARoot = join(root, 'versions', 'A');
      const versionBRoot = join(root, 'versions', 'B');
      const currentRoot = join(root, 'current');
      const nextCurrentRoot = join(root, 'next-current');
      try {
        const versionA = await writeRuntimeRoot({
          runtimeRoot: versionARoot,
          executableBytes: '#!/bin/sh\necho A\n',
        });
        await writeRuntimeRoot({
          runtimeRoot: versionBRoot,
          executableBytes: '#!/bin/sh\necho B\n',
        });
        await writeRuntimeRoot({
          runtimeRoot: currentRoot,
          executableBytes: '#!/bin/sh\necho A\n',
        });
        await writeRuntimeRoot({
          runtimeRoot: nextCurrentRoot,
          executableBytes: '#!/bin/sh\necho B\n',
        });
        const readIntegrity = cliDistBuildManifest.readCliRuntimeAssetIntegrity;
        const integritySpy = vi.spyOn(
          cliDistBuildManifest,
          'readCliRuntimeAssetIntegrity',
        ).mockImplementation((input) => {
          const result = readIntegrity(input);
          rmSync(currentRoot, { recursive: true, force: true });
          renameSync(nextCurrentRoot, currentRoot);
          return result;
        });

        try {
          await expect(resolveManagedProviderRuntimeExecutable(
            MANAGED_RUNTIME_REF,
            {
              platform: 'linux',
              resolveAssetPath: (...segments: string[]) => join(
                currentRoot,
                ...segments,
              ),
              resolveInstalledComponentPaths: vi.fn(() => ({
                installRoot: root,
                currentPath: currentRoot,
                previousPath: join(root, 'previous'),
                versionsDir: join(root, 'versions'),
                binaryPath: join(currentRoot, 'happier'),
                nodeEntrypointPath: join(currentRoot, 'package-dist', 'index.mjs'),
                shimPaths: [join(root, 'bin', 'happier')],
                resolvedCurrentPath: versionARoot,
                resolvedBinaryPath: join(versionARoot, 'happier'),
                resolvedNodeEntrypointPath: join(
                  versionARoot,
                  'package-dist',
                  'index.mjs',
                ),
              })),
            },
          )).resolves.toBe(await realpath(versionA.executablePath));
          expect(integritySpy).toHaveBeenCalledOnce();
          await expect(readFile(join(
            currentRoot,
            'tools',
            'unpacked',
            'happier-cliproxyapi-managed',
          ), 'utf8')).resolves.toContain('echo B');
        } finally {
          integritySpy.mockRestore();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['current root', 'current'],
    ['exact version root', 'version'],
    ['retained snapshot root', 'snapshot'],
  ] as const)('rejects corrupt managed runtime bytes in the %s', async (
    _label,
    rootKind,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-corrupt-runtime-'));
    const runtimeRoot = rootKind === 'snapshot'
      ? join(root, '.runner-snapshots', 'snapshot-a')
      : join(root, rootKind === 'version' ? 'versions/A' : 'current');
    try {
      const runtime = await writeRuntimeRoot({ runtimeRoot });
      await writeFile(runtime.executablePath, '#!/bin/sh\nexit 1\n', {
        mode: 0o755,
      });
      const dependencies = rootKind === 'snapshot'
        ? {
          platform: 'linux' as const,
          retainedRunnerRuntimeIdentity: 'snapshot:snapshot-a',
          runtimeModuleUrl: pathToFileURL(join(
            runtimeRoot,
            'package-dist',
            'managed-runtime.mjs',
          )).href,
          resolveRuntimeRootFromModuleUrl: vi.fn(() => runtimeRoot),
        }
        : rootKind === 'version'
          ? {
            platform: 'linux' as const,
            retainedRunnerRuntimeIdentity: 'version:A',
            resolveReleaseChannel: vi.fn(async () => ({
              ringId: 'stable' as const,
            })),
            resolveVersionInstallPath: vi.fn(() => runtimeRoot),
          }
          : {
            platform: 'linux' as const,
            resolveAssetPath: (...segments: string[]) => join(
              runtimeRoot,
              ...segments,
            ),
          };

      await expect(resolveManagedProviderRuntimeExecutable(
        MANAGED_RUNTIME_REF,
        dependencies,
      )).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['exact version root', 'version'],
    ['retained snapshot root', 'snapshot'],
  ] as const)('rejects a missing runtime asset record in the %s', async (
    _label,
    rootKind,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-missing-runtime-record-'));
    const runtimeRoot = rootKind === 'snapshot'
      ? join(root, '.runner-snapshots', 'snapshot-a')
      : join(root, 'versions', 'A');
    try {
      await writeRuntimeRoot({
        runtimeRoot,
        recordRuntimeAsset: false,
      });
      const dependencies = rootKind === 'snapshot'
        ? {
          platform: 'linux' as const,
          retainedRunnerRuntimeIdentity: 'snapshot:snapshot-a',
          runtimeModuleUrl: pathToFileURL(join(
            runtimeRoot,
            'package-dist',
            'managed-runtime.mjs',
          )).href,
          resolveRuntimeRootFromModuleUrl: vi.fn(() => runtimeRoot),
        }
        : {
          platform: 'linux' as const,
          retainedRunnerRuntimeIdentity: 'version:A',
          resolveReleaseChannel: vi.fn(async () => ({
            ringId: 'stable' as const,
          })),
          resolveVersionInstallPath: vi.fn(() => runtimeRoot),
        };
      await expect(resolveManagedProviderRuntimeExecutable(
        MANAGED_RUNTIME_REF,
        dependencies,
      )).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the module-derived snapshot does not match the retained runner identity', async () => {
    const statFile = vi.fn(async () => regularFile());

    await expect(resolveManagedProviderRuntimeExecutable({
      kind: 'packaged-runtime-binary',
      directorySegments: ['tools', 'unpacked'],
      executableBaseName: 'happier-cliproxyapi-managed',
    }, {
      platform: 'linux',
      retainedRunnerRuntimeIdentity: 'snapshot:snapshot-a',
      runtimeModuleUrl:
        'file:///repo/apps/cli/.runner-snapshots/snapshot-b/package-dist/managed-runtime.mjs',
      resolveRuntimeRootFromModuleUrl: vi.fn(() => (
        '/repo/apps/cli/.runner-snapshots/snapshot-b'
      )),
      statFile,
      resolveRealPath: vi.fn(async (path) => path),
    })).resolves.toBeNull();
    expect(statFile).not.toHaveBeenCalled();
  });

  it('rejects an exact-version asset whose real path escapes the version root', async () => {
    await expect(resolveManagedProviderRuntimeExecutable({
      kind: 'packaged-runtime-binary',
      directorySegments: ['tools', 'unpacked'],
      executableBaseName: 'happier-cliproxyapi-managed',
    }, {
      platform: 'linux',
      retainedRunnerRuntimeIdentity: 'version:A',
      resolveReleaseChannel: vi.fn(async () => ({ ringId: 'stable' as const })),
      resolveVersionInstallPath: vi.fn(() => '/home/.happier/cli/versions/A'),
      statFile: vi.fn(retainedRuntimePathStats(
        '/home/.happier/cli/versions/A',
      )),
      resolveRealPath: vi.fn(async (path) => (
        path.endsWith('/happier-cliproxyapi-managed')
          ? '/tmp/forged/happier-cliproxyapi-managed'
          : path
      )),
    })).resolves.toBeNull();
  });

  it.runIf(process.platform !== 'win32')(
    'resolves a real exact-version executable and rejects a same-named symlink',
    async () => {
      const root = await mkdtemp(join(
        tmpdir(),
        'happier-retained-managed-runtime-',
      ));
      const versionRoot = join(root, 'versions', 'A');
      const executablePath = join(
        versionRoot,
        'tools',
        'unpacked',
        'happier-cliproxyapi-managed',
      );
      const outsidePath = join(root, 'outside-runtime');
      try {
        await writeRuntimeRoot({ runtimeRoot: versionRoot });
        const dependencies = {
          platform: 'linux' as const,
          retainedRunnerRuntimeIdentity: 'version:A',
          resolveReleaseChannel: vi.fn(async () => ({
            ringId: 'stable' as const,
          })),
          resolveVersionInstallPath: vi.fn(() => versionRoot),
        };
        const ref = {
          kind: 'packaged-runtime-binary' as const,
          directorySegments: ['tools', 'unpacked'] as const,
          executableBaseName: 'happier-cliproxyapi-managed',
        };

        await expect(resolveManagedProviderRuntimeExecutable(
          ref,
          dependencies,
        )).resolves.toBe(await realpath(executablePath));

        await writeFile(outsidePath, '#!/bin/sh\nexit 0\n', {
          mode: 0o755,
        });
        await rm(executablePath);
        await symlink(outsidePath, executablePath);
        await expect(resolveManagedProviderRuntimeExecutable(
          ref,
          dependencies,
        )).resolves.toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects an exact-version root that is a symlink to another version',
    async () => {
      const root = await mkdtemp(join(
        tmpdir(),
        'happier-retained-managed-runtime-root-',
      ));
      const versionARoot = join(root, 'versions', 'A');
      const versionBRoot = join(root, 'versions', 'B');
      const executablePath = join(
        versionBRoot,
        'tools',
        'unpacked',
        'happier-cliproxyapi-managed',
      );
      try {
        await mkdir(join(versionBRoot, 'tools', 'unpacked'), {
          recursive: true,
        });
        await writeFile(executablePath, '#!/bin/sh\nexit 0\n', {
          mode: 0o755,
        });
        await symlink(versionBRoot, versionARoot, 'dir');

        await expect(resolveManagedProviderRuntimeExecutable({
          kind: 'packaged-runtime-binary',
          directorySegments: ['tools', 'unpacked'],
          executableBaseName: 'happier-cliproxyapi-managed',
        }, {
          platform: 'linux',
          retainedRunnerRuntimeIdentity: 'version:A',
          resolveReleaseChannel: vi.fn(async () => ({
            ringId: 'stable' as const,
          })),
          resolveVersionInstallPath: vi.fn(() => versionARoot),
        })).resolves.toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

});
