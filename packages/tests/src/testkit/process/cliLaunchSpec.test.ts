import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const sharedDepsBuildMock = vi.hoisted(() => ({
  ensureCliSharedDepsBuilt: vi.fn(async ({ testDir, env }: { testDir: string; env: NodeJS.ProcessEnv }) => {
    void testDir;
    void env;
  }),
}));

vi.mock('./cliDist', async () => {
  const actual = await vi.importActual<typeof import('./cliDist')>('./cliDist');
  return {
    ...actual,
    ensureCliSharedDepsBuilt: sharedDepsBuildMock.ensureCliSharedDepsBuilt,
  };
});

import { resolveCliTestLaunchSpec } from './cliLaunchSpec';

describe('resolveCliTestLaunchSpec', () => {
  it('ensures source-entrypoint launches refresh shared deps before snapshotting bundled node_modules', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'release-runtime', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, '.project'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_version_utils.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/release-runtime',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: {
              '.': { default: './dist/index.js' },
              './github': { default: './dist/github.js' },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'release-runtime', 'package.json'),
        JSON.stringify({ name: '@happier-dev/release-runtime' }),
        'utf8',
      );

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockImplementationOnce(async () => {
        mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), {
          recursive: true,
        });
        writeFileSync(
          resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'),
          'export const live = true;\n',
          'utf8',
        );
      });

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
          },
        },
        {
          repoRoot,
          snapshotDir,
        },
      );

      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).toHaveBeenCalledTimes(1);
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain('--preserve-symlinks');
      expect(spec.args).toContain('--preserve-symlinks-main');
      expect(spec.args).toContain(resolve(snapshotDir, 'src', 'index.ts'));
      expect(existsSync(resolve(snapshotDir, 'scripts', 'claude_version_utils.cjs'))).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'tools', 'launch-helper.txt'))).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'bin', 'launch-helper.txt'))).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'))).toBe(true);
      const nodeModulesEntry = lstatSync(resolve(snapshotDir, 'node_modules'));
      expect(nodeModulesEntry.isSymbolicLink() || nodeModulesEntry.isDirectory()).toBe(true);
      expect(spec.env?.TSX_TSCONFIG_PATH).toBe(resolve(snapshotDir, 'tsconfig.json'));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('can skip refreshing shared deps when source-entrypoint launches only need existing outputs', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-skip-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'release-runtime', 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_version_utils.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/release-runtime',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            exports: {
              '.': { default: './dist/index.js' },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'release-runtime', 'package.json'),
        JSON.stringify({ name: '@happier-dev/release-runtime' }),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'), 'export {};\n', 'utf8');

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockClear();

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
          },
        },
        {
          repoRoot,
          snapshotDir,
        },
      );

      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).not.toHaveBeenCalled();
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain(resolve(snapshotDir, 'src', 'index.ts'));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('can symlink snapshot node_modules for source-entrypoint launches', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-symlink-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_version_utils.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
          },
        },
        {
          repoRoot,
          snapshotDir,
        },
      );

      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain(resolve(snapshotDir, 'src', 'index.ts'));
      expect(lstatSync(resolve(snapshotDir, 'node_modules')).isSymbolicLink()).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'scripts', 'claude_version_utils.cjs'))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
