import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = '/repo';
const srcPackageDir = `${repoRoot}/packages/protocol`;
const srcPackageJsonPath = `${srcPackageDir}/package.json`;
const srcDistDir = `${srcPackageDir}/dist`;
const destPackageDir = `${repoRoot}/apps/stack/node_modules/@happier-dev/protocol`;
const destDistDir = `${destPackageDir}/dist`;
const staleTmpDir = `${destPackageDir}/dist.__sync_tmp__.old-staging`;
const staleBackupDir = `${destPackageDir}/dist.__sync_backup__.old-staging`;
const destPackageJsonPath = `${destPackageDir}/package.json`;

const removedPaths: string[] = [];
const copiedPaths: Array<[string, string]> = [];
const writtenFiles: Array<[string, string]> = [];

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    cpSync: vi.fn((src: string, dest: string) => {
      copiedPaths.push([String(src), String(dest)]);
    }),
    existsSync: vi.fn((path: string) => {
      const candidate = String(path);
      return (
        candidate === srcPackageJsonPath ||
        candidate === srcDistDir ||
        candidate === destPackageDir ||
        candidate === staleTmpDir ||
        candidate === staleBackupDir
      );
    }),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn((path: string) => {
      if (String(path) !== destPackageDir) return [];
      return [
        { name: 'dist', isDirectory: () => true },
        { name: 'dist.__sync_tmp__.old-staging', isDirectory: () => true },
        { name: 'dist.__sync_backup__.old-staging', isDirectory: () => true },
      ];
    }),
    readFileSync: vi.fn((path: string) => {
      if (String(path) !== srcPackageJsonPath) {
        throw new Error(`Unexpected readFileSync path: ${String(path)}`);
      }
      return JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
      });
    }),
    rmSync: vi.fn((path: string) => {
      const candidate = String(path);
      if (candidate === staleTmpDir || candidate === staleBackupDir) {
        removedPaths.push(candidate);
        return;
      }
      if (candidate === destPackageDir) {
        if (!removedPaths.includes(staleTmpDir) || !removedPaths.includes(staleBackupDir)) {
          const error = new Error('ENOTEMPTY') as Error & { code?: string };
          error.code = 'ENOTEMPTY';
          throw error;
        }
        removedPaths.push(candidate);
        return;
      }
      if (candidate === destDistDir) {
        removedPaths.push(candidate);
      }
    }),
    writeFileSync: vi.fn((path: string, value: string) => {
      writtenFiles.push([String(path), String(value)]);
    }),
  };
});

import { bundleWorkspacePackage } from './index';

describe('bundleWorkspacePackage', () => {
  afterEach(() => {
    removedPaths.length = 0;
    copiedPaths.length = 0;
    writtenFiles.length = 0;
    vi.clearAllMocks();
  });

  it('removes stale bundled-package temp dirs before resetting the package dir', () => {
    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(removedPaths).toEqual([staleTmpDir, staleBackupDir, destPackageDir]);
    expect(copiedPaths).toContainEqual([srcDistDir, destDistDir]);
    expect(writtenFiles).toContainEqual([
      destPackageJsonPath,
      expect.stringContaining('"private": true'),
    ]);
  });
});
