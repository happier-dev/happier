import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { preparePkgrollPackageManifest, runPkgrollBuild } from '../runPkgrollBuild.mjs';

describe('runPkgrollBuild', () => {
  it('rewrites package-dist entrypoints to dist for pkgroll without modifying publish file allowlists', () => {
    const manifest = preparePkgrollPackageManifest({
      main: './package-dist/index.cjs',
      module: './package-dist/index.mjs',
      types: './package-dist/index.d.cts',
      exports: {
        '.': {
          require: {
            types: './package-dist/index.d.cts',
            default: './package-dist/index.cjs',
          },
          import: {
            types: './package-dist/index.d.mts',
            default: './package-dist/index.mjs',
          },
        },
      },
      bin: {
        happier: './bin/happier.mjs',
      },
      files: ['package-dist', 'package-dist/**', 'bin'],
    });

    expect(manifest).toMatchObject({
      main: './dist/index.cjs',
      module: './dist/index.mjs',
      types: './dist/index.d.cts',
      exports: {
        '.': {
          require: {
            types: './dist/index.d.cts',
            default: './dist/index.cjs',
          },
          import: {
            types: './dist/index.d.mts',
            default: './dist/index.mjs',
          },
        },
      },
      files: ['package-dist', 'package-dist/**', 'bin'],
    });
    expect(manifest).not.toHaveProperty('bin');
  });

  it('restores the original package manifest after pkgroll finishes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-cli-pkgroll-manifest-'));
    const packageJsonPath = join(dir, 'package.json');
    const original = {
      main: './package-dist/index.cjs',
      bin: {
        happier: './bin/happier.mjs',
      },
      exports: {
        '.': {
          import: {
            default: './package-dist/index.mjs',
          },
        },
      },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    let pkgrollManifest: any = null;
    const spawn = vi.fn(() => {
      pkgrollManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return { status: 0 };
    });

    runPkgrollBuild({ packageJsonPath, spawn });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('pkgroll/dist/cli.mjs')],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(pkgrollManifest).toBeTruthy();
    expect(pkgrollManifest).not.toHaveProperty('bin');
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
  });
});
