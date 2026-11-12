import { copyFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializePrepublicationAuthorWorkspacePackages } from './toolchain';

// The filesystem is the system boundary. Count synchronous copies in the
// observing daemon process; the real child and materializer remain unmocked.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, copyFileSync: vi.fn(actual.copyFileSync) };
});

afterEach(() => vi.unstubAllEnvs());

describe('author package materialization transport liveness', () => {
  it('copies the real-scale SDK file inventory without synchronous copies in the observer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-author-materialize-process-'));
    const sdkRoot = join(root, 'sdk');
    const projectRoot = join(root, 'author');
    const packageName = '@happier-dev/plugin-sdk';
    try {
      await mkdir(join(sdkRoot, 'dist'), { recursive: true });
      await mkdir(projectRoot);
      await writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
        name: packageName, version: '0.0.0', type: 'module', main: 'dist/index.js', types: 'dist/index.d.ts',
        files: ['dist'], happier: { publicSdkRelease: { posture: 'developer_preview' } },
      }));
      await writeFile(join(sdkRoot, 'dist', 'index.js'), 'export const marker = "author-sdk";');
      await writeFile(join(sdkRoot, 'dist', 'index.d.ts'), 'export declare const marker: string;');
      // #75b's physical SDK has 18,925 files. Preserve that metadata workload
      // without duplicating its 571 MB of third-party payload in the test.
      for (let index = 3; index < 18_925; index += 1) {
        await writeFile(join(sdkRoot, 'dist', 'input-' + index + '.js'), '');
      }
      vi.stubEnv('HAPPIER_CLI_SUBPROCESS_PREFER_TSX', '1');
      vi.mocked(copyFileSync).mockClear();
      const materialized = await materializePrepublicationAuthorWorkspacePackages({
        projectRoot, packageNames: [packageName],
        bundles: [{ packageName, srcDir: sdkRoot, destDir: join(root, 'unused') }],
      });
      try {
        const installedRoot = materialized.packageRootsByName.get(packageName)!;
        await expect(readFile(join(installedRoot, 'dist', 'index.js'), 'utf8')).resolves.toContain('author-sdk');
        const observerCopies = vi.mocked(copyFileSync).mock.calls.filter(([sourcePath]) => String(sourcePath).startsWith(sdkRoot));
        expect(observerCopies, 'SDK closure copies must not block the daemon heartbeat').toHaveLength(0);
      } finally {
        await materialized.cleanup();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
  it('retains a definite native filesystem failure from the real child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-author-materialize-failure-'));
    try {
      vi.stubEnv('HAPPIER_CLI_SUBPROCESS_PREFER_TSX', '1');
      await expect(materializePrepublicationAuthorWorkspacePackages({
        projectRoot: root,
        packageNames: ['@happier-dev/plugin-sdk'],
        bundles: [{ packageName: '@happier-dev/plugin-sdk', srcDir: join(root, 'missing'), destDir: join(root, 'unused') }],
      })).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
