import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import { collectMissingExportTargets } from './verifyExports.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptsDir);

describe('cli-common build export verification', () => {
  it('exports a web-safe Tailscale task contract entrypoint', () => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

    expect(packageJson.exports).toMatchObject({
      './tailscale/taskContract': {
        types: './dist/tailscale/taskContract.d.ts',
        default: './dist/tailscale/taskContract.js',
      },
    });
  });

  it('runs staged export verification as part of the package build', async () => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

    expect(packageJson.scripts.build).toBe('node scripts/build.mjs');

    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-staged-build-'));

    try {
      mkdirSync(join(fixtureDir, 'dist'), { recursive: true });
      writeFileSync(join(fixtureDir, 'dist', 'index.js'), 'export const oldValue = true;\n', 'utf8');
      writeFileSync(join(fixtureDir, 'dist', 'index.d.ts'), 'export declare const oldValue: boolean;\n', 'utf8');
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

      await buildCliCommonDist({
        packageDir: fixtureDir,
        buildId: 'test-build',
        lockPath: join(fixtureDir, 'build.lock'),
        runCommandImpl: (_cmd, args) => {
          const oldDistDuringBuild = readFileSync(join(fixtureDir, 'dist', 'index.js'), 'utf8');
          expect(oldDistDuringBuild).toContain('oldValue');

          const tsconfigPath = args.at(-1);
          const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
          const outDir = tsconfig.compilerOptions.outDir;
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, 'index.js'), 'export const newValue = true;\n', 'utf8');
          writeFileSync(join(outDir, 'index.d.ts'), 'export declare const newValue: boolean;\n', 'utf8');
          return { status: 0 };
        },
      });

      expect(readFileSync(join(fixtureDir, 'dist', 'index.js'), 'utf8')).toContain('newValue');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('runs the Windows yarn.cmd shim through cmd.exe and ignores npm_execpath npm shims', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-windows-yarn-shim-'));
    const commands = [];
    const buildId = 'windows-yarn-shim';
    const comspec = 'C:\\Windows\\System32\\cmd.exe';

    try {
      mkdirSync(join(fixtureDir, 'dist'), { recursive: true });
      writeFileSync(join(fixtureDir, 'dist', 'index.js'), 'export const oldValue = true;\n', 'utf8');
      writeFileSync(join(fixtureDir, 'dist', 'index.d.ts'), 'export declare const oldValue: boolean;\n', 'utf8');
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

      await buildCliCommonDist({
        packageDir: fixtureDir,
        buildId,
        lockPath: join(fixtureDir, 'build.lock'),
        platform: 'win32',
        env: {
          ...process.env,
          npm_execpath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
          COMSPEC: comspec,
        },
        runCommandImpl: (cmd, args, options = {}) => {
          commands.push({ cmd, args, options });
          const tsconfigPath = join(fixtureDir, `.tsconfig.build.${buildId}.json`);
          const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
          const outDir = tsconfig.compilerOptions.outDir;
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, 'index.js'), 'export const newValue = true;\n', 'utf8');
          writeFileSync(join(outDir, 'index.d.ts'), 'export declare const newValue: boolean;\n', 'utf8');
          return { status: 0 };
        },
      });

      expect(commands).toHaveLength(1);
      expect(commands[0].cmd).toBe(comspec);
      expect(commands[0].options.windowsVerbatimArguments).toBe(true);
      expect(commands[0].args.join(' ')).toContain('yarn.cmd');
      expect(commands[0].args.join(' ')).not.toContain('npm-cli.js');
      expect(readFileSync(join(fixtureDir, 'dist', 'index.js'), 'utf8')).toContain('newValue');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('detects missing files for declared export targets', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-exports-'));

    try {
      mkdirSync(join(fixtureDir, 'dist', 'links'), { recursive: true });
      writeFileSync(join(fixtureDir, 'dist', 'links', 'index.js'), 'export const ok = true;\n', 'utf8');
      writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli-common-fixture',
        exports: {
          './links': {
            default: './dist/links/index.js',
          },
          './tailscale': {
            default: './dist/tailscale/index.js',
          },
        },
      }, null, 2), 'utf8');

      expect(collectMissingExportTargets({
        packageDir: fixtureDir,
        packageJson: JSON.parse(readFileSync(join(fixtureDir, 'package.json'), 'utf8')),
      })).toEqual([
        {
          target: './dist/tailscale/index.js',
          relativePath: 'dist/tailscale/index.js',
        },
      ]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
