import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { runPkgrollBuild } from '../runPkgrollBuild.mjs';

describe('runPkgrollBuild', () => {
  it('runs pkgroll with a package.json entrypoint filter without mutating the package manifest', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-manifest-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    const original = {
      main: './dist/index.cjs',
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
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    let manifestObservedByPkgroll: any = null;
    const spawn = vi.fn(() => {
      manifestObservedByPkgroll = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return { status: 0 };
    });

    runPkgrollBuild({ cwd: dir, pkgrollCliPath, spawn });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [pkgrollCliPath, '--packagejson', 'dist/**'],
      expect.objectContaining({
        cwd: dir,
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 600_000,
      }),
    );
    expect(manifestObservedByPkgroll).toEqual(original);
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
  });

  it('fails fast with a clear error when the resolved pkgroll entrypoint is a shell shim without mutating the manifest', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-shell-shim-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-shell-shim.mjs');
    const original = {
      main: './package-dist/index.cjs',
      exports: {
        '.': {
          import: {
            default: './package-dist/index.mjs',
          },
        },
      },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/bin/sh\nexec node "$0" "$@"\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    expect(() =>
      runPkgrollBuild({
        cwd: dir,
        pkgrollCliPath,
        spawn,
      }),
    ).toThrow(/expected a JavaScript entrypoint but found a shell wrapper/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
  });

  it('applies bounded timeout override from environment for Windows stall protection', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-timeout-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './package-dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    runPkgrollBuild({
      cwd: dir,
      pkgrollCliPath,
      spawn,
      env: { HAPPIER_CLI_PKGROLL_TIMEOUT_MS: '120000' },
    });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [pkgrollCliPath, '--packagejson', 'dist/**'],
      expect.objectContaining({
        timeout: 120_000,
      }),
    );
  });
});
