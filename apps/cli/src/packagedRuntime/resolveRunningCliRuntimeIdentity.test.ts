import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

import { resolveRunningCliRuntimeIdentity } from './resolveRunningCliRuntimeIdentity';

const createdRoots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-running-runtime-'));
  createdRoots.push(root);
  return root;
}

describe('resolveRunningCliRuntimeIdentity', () => {
  afterEach(() => {
    while (createdRoots.length > 0) {
      rmSync(createdRoots.pop()!, { recursive: true, force: true });
    }
  });

  it('names the packaged tree and its build date so a stale bundle is visible', () => {
    const root = createRoot();
    const outputDir = join(root, 'package-dist');
    mkdirSync(outputDir, { recursive: true });
    const entrypoint = join(outputDir, 'index.mjs');
    writeFileSync(entrypoint, 'export const x = 1;\n', 'utf8');
    cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
      outputDir,
      builtAt: '2026-07-30T03:46:27.372Z',
    });

    expect(
      resolveRunningCliRuntimeIdentity(pathToFileURL(join(outputDir, 'chunk-abc.mjs')).href),
    ).toEqual({
      entrypoint,
      tree: 'package-dist',
      builtAt: '2026-07-30T03:46:27.372Z',
      manifestVerified: true,
    });
  });

  it('reports an unverifiable bundle rather than implying it is current', () => {
    const root = createRoot();
    const outputDir = join(root, 'dist');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'index.mjs'), 'export const x = 1;\n', 'utf8');

    expect(
      resolveRunningCliRuntimeIdentity(pathToFileURL(join(outputDir, 'chunk-abc.mjs')).href),
    ).toEqual({
      entrypoint: join(outputDir, 'index.mjs'),
      tree: 'dist',
      builtAt: null,
      manifestVerified: false,
    });
  });

  it('reports a source checkout as source rather than as a packaged bundle', () => {
    const root = createRoot();
    mkdirSync(join(root, 'src', 'packagedRuntime'), { recursive: true });

    expect(
      resolveRunningCliRuntimeIdentity(
        pathToFileURL(join(root, 'src', 'packagedRuntime', 'x.ts')).href,
      ),
    ).toEqual({
      entrypoint: join(root, 'src', 'index.ts'),
      tree: 'source',
      builtAt: null,
      manifestVerified: false,
    });
  });

  it('reports a pinned runner snapshot as its own runtime', () => {
    const root = createRoot();
    const snapshotDir = join(root, '.runner-snapshots', 'abc123');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'index.mjs'), 'export const x = 1;\n', 'utf8');

    expect(
      resolveRunningCliRuntimeIdentity(pathToFileURL(join(snapshotDir, 'chunk.mjs')).href),
    ).toMatchObject({
      entrypoint: join(snapshotDir, 'index.mjs'),
      tree: 'runner-snapshot',
    });
  });
});
