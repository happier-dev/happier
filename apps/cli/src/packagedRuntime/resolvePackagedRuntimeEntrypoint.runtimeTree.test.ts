import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

import { resolvePackagedRuntimeEntrypoint } from './resolvePackagedRuntimeEntrypoint';

const { installedFirstPartyComponentPathsMock } = vi.hoisted(() => ({
  installedFirstPartyComponentPathsMock: vi.fn<() => Record<string, string | string[]>>(() => {
    throw new Error('no managed install');
  }),
}));

// Installed-payload discovery reads the user's real home directory — a genuine boundary.
vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>()),
  readDefaultManagedReleaseChannelSync: () => 'publicdev' as const,
  resolveInstalledFirstPartyComponentPaths: installedFirstPartyComponentPathsMock,
}));

/**
 * These cases use real directories and the canonical build-manifest producer so the
 * selection logic under test stays real; only the filesystem (a genuine boundary) is
 * materialised. They pin the contract that decides which CLI bundle a spawned child
 * process executes.
 */
const createdRoots: string[] = [];

function createRuntimeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-runtime-tree-'));
  createdRoots.push(root);
  return root;
}

function writeRuntimeTree(
  root: string,
  tree: string,
  options: Readonly<{ manifest: boolean; builtAt?: string }>,
): string {
  const outputDir = join(root, tree);
  mkdirSync(outputDir, { recursive: true });
  const entrypoint = join(outputDir, 'index.mjs');
  writeFileSync(entrypoint, `export const runtimeTree = ${JSON.stringify(tree)};\n`, 'utf8');
  if (options.manifest) {
    cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
      outputDir,
      ...(options.builtAt ? { builtAt: options.builtAt } : {}),
    });
  }
  return entrypoint;
}

describe('resolvePackagedRuntimeEntrypoint runtime-tree selection', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    installedFirstPartyComponentPathsMock.mockReset();
    installedFirstPartyComponentPathsMock.mockImplementation(() => {
      throw new Error('no managed install');
    });
    while (createdRoots.length > 0) {
      rmSync(createdRoots.pop()!, { recursive: true, force: true });
    }
  });

  it('keeps a checkout-launched process on its own runtime root instead of a managed install', () => {
    const checkoutRoot = createRuntimeRoot();
    mkdirSync(join(checkoutRoot, 'src'), { recursive: true });
    const checkoutDistEntrypoint = writeRuntimeTree(checkoutRoot, 'dist', {
      manifest: true,
      builtAt: '2026-08-24T13:19:04.798Z',
    });

    const installedRoot = createRuntimeRoot();
    writeRuntimeTree(installedRoot, 'package-dist', { manifest: false });
    installedFirstPartyComponentPathsMock.mockImplementation(() => ({
      resolvedCurrentPath: installedRoot,
      resolvedNodeEntrypointPath: join(installedRoot, 'package-dist', 'index.mjs'),
      shimPaths: [],
    }));

    // The bin wrapper is argv[1], so the launched-process evidence names no runtime root
    // and managed-install discovery would otherwise be the first candidate root.
    process.argv = [process.argv[0]!, join(checkoutRoot, 'bin', 'happier.mjs'), 'daemon', 'start'];

    expect(
      resolvePackagedRuntimeEntrypoint('index.mjs', {
        moduleUrl: pathToFileURL(join(checkoutRoot, 'dist', 'chunk-abc.mjs')).href,
      }),
    ).toBe(checkoutDistEntrypoint);
  });

  it('gives a child the runtime tree the current process is executing, not a stale sibling tree', () => {
    const root = createRuntimeRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    const distEntrypoint = writeRuntimeTree(root, 'dist', {
      manifest: true,
      builtAt: '2026-08-24T13:19:04.798Z',
    });
    writeRuntimeTree(root, 'package-dist', {
      manifest: true,
      builtAt: '2026-07-30T03:46:27.372Z',
    });

    // The bin bootstrap replaces argv[1] with the wrapper, so the launched-process
    // evidence names the root but not the tree.
    process.argv = [process.argv[0]!, join(root, 'dist', 'index.mjs'), 'daemon', 'start'];

    expect(
      resolvePackagedRuntimeEntrypoint('index.mjs', {
        moduleUrl: pathToFileURL(join(root, 'dist', 'chunk-abc.mjs')).href,
      }),
    ).toBe(distEntrypoint);
  });

  it('keeps a packaged parent on its own package-dist tree even when a newer dist tree exists', () => {
    const root = createRuntimeRoot();
    writeRuntimeTree(root, 'dist', { manifest: true, builtAt: '2026-08-24T13:19:04.798Z' });
    const packageDistEntrypoint = writeRuntimeTree(root, 'package-dist', {
      manifest: true,
      builtAt: '2026-07-30T03:46:27.372Z',
    });

    process.argv = [process.argv[0]!, join(root, 'package-dist', 'index.mjs'), 'daemon', 'start'];

    expect(
      resolvePackagedRuntimeEntrypoint('index.mjs', {
        moduleUrl: pathToFileURL(join(root, 'package-dist', 'chunk-abc.mjs')).href,
      }),
    ).toBe(packageDistEntrypoint);
  });

  it('prefers a manifest-valid tree over a half-built one when the parent runs from source', () => {
    const root = createRuntimeRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    // A dist tree mid-rebuild: the entrypoint exists but carries no build manifest.
    writeRuntimeTree(root, 'dist', { manifest: false });
    const packageDistEntrypoint = writeRuntimeTree(root, 'package-dist', {
      manifest: true,
      builtAt: '2026-07-30T03:46:27.372Z',
    });

    process.argv = [process.argv[0]!, join(root, 'dist', 'index.mjs'), 'daemon', 'start'];

    expect(
      resolvePackagedRuntimeEntrypoint('index.mjs', {
        moduleUrl: pathToFileURL(join(root, 'src', 'index.ts')).href,
      }),
    ).toBe(packageDistEntrypoint);
  });

  it('never hands a child a half-built tree when a manifest-valid sibling exists', () => {
    const root = createRuntimeRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeRuntimeTree(root, 'package-dist', { manifest: false });
    const distEntrypoint = writeRuntimeTree(root, 'dist', {
      manifest: true,
      builtAt: '2026-08-24T13:19:04.798Z',
    });

    process.argv = [process.argv[0]!, join(root, 'dist', 'index.mjs'), 'daemon', 'start'];

    expect(
      resolvePackagedRuntimeEntrypoint('index.mjs', {
        moduleUrl: pathToFileURL(join(root, 'src', 'index.ts')).href,
      }),
    ).toBe(distEntrypoint);
  });

  it('keeps a manifest-less installed payload resolving to its package-dist runtime', () => {
    const root = createRuntimeRoot();
    const packageDistEntrypoint = writeRuntimeTree(root, 'package-dist', { manifest: false });

    process.argv = [process.argv[0]!, join(root, 'package-dist', 'index.mjs'), 'happier'];

    expect(
      resolvePackagedRuntimeEntrypoint('index.mjs', {
        moduleUrl: pathToFileURL(join(root, 'package-dist', 'chunk-abc.mjs')).href,
      }),
    ).toBe(packageDistEntrypoint);
  });
});
