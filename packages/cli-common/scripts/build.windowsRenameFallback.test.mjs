import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const { renameMock, renameDelegate } = vi.hoisted(() => ({
  renameMock: vi.fn(),
  renameDelegate: { current: null },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  renameDelegate.current = actual.rename;
  return {
    ...actual,
    rename: renameMock,
  };
});

describe('cli-common build rename boundaries', () => {
  const tempDirs = [];

  afterEach(() => {
    renameMock.mockReset();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('populates an outer publisher on another device without renaming its output', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-exdev-'));
    tempDirs.push(root);
    const packageDir = join(root, 'capture', 'packages', 'cli-common');
    const distDir = join(packageDir, 'dist');
    const outputDir = join(root, 'workspace', 'staged-dist');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(distDir, 'index.js'), 'export const oldValue = true;\n');
    writeFileSync(join(outputDir, 'publisher-owned'), 'retained');
    const packageJson = {
      name: '@happier-dev/cli-common-fixture',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    };
    renameMock.mockImplementation(async (from, to) => {
      if (String(from).startsWith(`${packageDir}${sep}`) && to === outputDir) {
        const error = new Error(`EXDEV: cross-device rename '${from}' -> '${to}'`);
        error.code = 'EXDEV';
        throw error;
      }
      return renameDelegate.current(from, to);
    });

    await buildCliCommonDist({
      packageDir,
      packageJson,
      env: { HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: outputDir },
      buildIntoDistDir: async ({ stagingDistDir }) => {
        mkdirSync(join(stagingDistDir, 'nested'), { recursive: true });
        writeFileSync(join(stagingDistDir, 'index.js'), 'export const newValue = true;\n');
        writeFileSync(join(stagingDistDir, 'index.d.ts'), 'export declare const newValue: boolean;\n');
        writeFileSync(join(stagingDistDir, 'nested', 'value.js'), 'export const nested = true;\n');
      },
    });

    expect(readFileSync(join(outputDir, 'index.js'), 'utf8')).toContain('newValue');
    expect(readFileSync(join(outputDir, 'index.d.ts'), 'utf8')).toContain('newValue');
    expect(readFileSync(join(outputDir, 'nested', 'value.js'), 'utf8')).toContain('nested');
    expect(readFileSync(join(outputDir, 'publisher-owned'), 'utf8')).toBe('retained');
    expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('oldValue');
    expect(renameMock.mock.calls.some(([from, to]) => from === outputDir || to === outputDir)).toBe(false);
  });

  it('copies staged dist into place when Windows blocks rename with EPERM', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-win32-'));
    tempDirs.push(fixtureDir);
    const distDir = join(fixtureDir, 'dist');

    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.js'), 'export const oldValue = true;\n', 'utf8');
    writeFileSync(join(distDir, 'index.d.ts'), 'export declare const oldValue: boolean;\n', 'utf8');
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common-fixture',
      exports: {
        '.': {
          default: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
    }, null, 2), 'utf8');
    writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        outDir: 'dist',
        tsBuildInfoFile: 'dist/.tsbuildinfo',
      },
    }, null, 2), 'utf8');

    if (!renameDelegate.current) {
      throw new Error('expected node:fs/promises.rename delegate to initialize');
    }

    renameMock.mockImplementation(async (from, to) => {
      if (to === distDir && String(from).includes('.dist.hstack-stage-')) {
        const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
        error.code = 'EPERM';
        throw error;
      }
      return renameDelegate.current(from, to);
    });

    await buildCliCommonDist({
      packageDir: fixtureDir,
      lockPath: join(fixtureDir, 'build.lock'),
      runCommandImpl: (_cmd, args) => {
        const outDir = args.at(args.indexOf('--outDir') + 1);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.js'), 'export const newValue = true;\n', 'utf8');
        writeFileSync(join(outDir, 'index.d.ts'), 'export declare const newValue: boolean;\n', 'utf8');
        return { status: 0 };
      },
    });

    expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('newValue');
  });
});
