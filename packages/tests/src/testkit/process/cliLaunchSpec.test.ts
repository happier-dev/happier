import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '@happier-dev/cli-common/workspaceBundleLock';

const sharedDepsBuildMock = vi.hoisted(() => ({
  ensureCliSharedDepsBuilt: vi.fn(async ({ testDir, env }: { testDir: string; env: NodeJS.ProcessEnv }) => {
    void testDir;
    void env;
  }),
  ensureCliSourceDevSharedDepsCurrent: vi.fn(async () => undefined),
  ensureCliDistSnapshotEntrypoint: vi.fn(
    async (
      _params: { testDir: string; env: NodeJS.ProcessEnv },
      _options: { repoRoot?: string; snapshotDir: string },
    ) => resolve(_options.snapshotDir, 'dist', 'index.mjs'),
  ),
}));

const fsPromisesMock = vi.hoisted(() => ({
  rm: vi.fn(),
}));

const runLoggedCommandMock = vi.hoisted(() => ({
  runLoggedCommand: vi.fn(async () => undefined),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsPromisesMock.rm.mockImplementation(actual.rm);
  return {
    ...actual,
    rm: fsPromisesMock.rm,
  };
});

vi.mock('./spawnProcess', async () => {
  const actual = await vi.importActual<typeof import('./spawnProcess')>('./spawnProcess');
  return {
    ...actual,
    runLoggedCommand: runLoggedCommandMock.runLoggedCommand,
  };
});

vi.mock('./cliDist', async () => {
  const actual = await vi.importActual<typeof import('./cliDist')>('./cliDist');
  return {
    ...actual,
    ensureCliSharedDepsBuilt: sharedDepsBuildMock.ensureCliSharedDepsBuilt,
    ensureCliSourceDevSharedDepsCurrent: sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent,
    ensureCliDistSnapshotEntrypoint: sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint,
  };
});

import { resolveCliTestLaunchSpec } from './cliLaunchSpec';

function resolveSourceSnapshotDir(spec: Readonly<{ args: readonly string[] }>): string {
  const sourceEntrypoint = spec.args.at(-1);
  if (!sourceEntrypoint) throw new Error('source launch spec has no entrypoint');
  return resolve(sourceEntrypoint, '..', '..');
}

function expectCanonicalPublishedSourceSnapshotDir(
  publishedSnapshotDir: string,
  requestedSnapshotDir: string,
): void {
  expect(dirname(publishedSnapshotDir)).toBe(dirname(requestedSnapshotDir));
  expect(basename(publishedSnapshotDir)).toMatch(
    /^cli-source-snapshot-source-\d+-\d+-\d+$/u,
  );
}

describe('resolveCliTestLaunchSpec', () => {
  it('launches an already-prepared dist snapshot without rebuilding or falling back to source mode', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-prepared-'));
    const snapshotDir = resolve(repoRoot, 'prepared-snapshot');

    try {
      mkdirSync(resolve(snapshotDir, 'dist'), { recursive: true });
      mkdirSync(resolve(snapshotDir, 'node_modules'), { recursive: true });
      writeFileSync(resolve(snapshotDir, '.cli-dist-snapshot.ready.json'), '{"v":1}\n', 'utf8');
      writeFileSync(resolve(snapshotDir, 'dist', 'index.mjs'), 'export {};\n', 'utf8');

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockClear();
      sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent.mockClear();
      sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint.mockClear();

      const spec = await resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          },
        },
        {
          repoRoot,
          snapshotDir,
          preparedDistSnapshotOnly: true,
        },
      );

      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).not.toHaveBeenCalled();
      expect(sharedDepsBuildMock.ensureCliDistSnapshotEntrypoint).not.toHaveBeenCalled();
      expect(spec).toEqual({
        command: process.execPath,
        args: ['--preserve-symlinks', resolve(snapshotDir, 'dist', 'index.mjs')],
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('launches an already-verified binary release payload through its packaged Node entrypoint', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-release-'));
    const snapshotDir = resolve(repoRoot, 'release-snapshot');

    try {
      mkdirSync(resolve(snapshotDir, 'package-dist'), { recursive: true });
      mkdirSync(resolve(snapshotDir, 'node_modules'), { recursive: true });
      writeFileSync(resolve(snapshotDir, '.cli-dist-snapshot.ready.json'), '{"v":1}\n', 'utf8');
      writeFileSync(resolve(snapshotDir, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');

      await expect(resolveCliTestLaunchSpec(
        { testDir: resolve(repoRoot, '.project'), env: process.env },
        { repoRoot, snapshotDir, preparedDistSnapshotOnly: true },
      )).resolves.toEqual({
        command: process.execPath,
        args: ['--preserve-symlinks', resolve(snapshotDir, 'package-dist', 'index.mjs')],
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('ensures source-entrypoint launches refresh shared deps before snapshotting bundled node_modules', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-'));
    const snapshotDir = resolve(repoRoot, 'caller-selected-launch-snapshot');

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
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
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

      sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent.mockClear();
      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockImplementationOnce(async ({ env }) => {
        expect(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD).toEqual(expect.any(String));
        expect(existsSync(resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'))).toBe(true);
        mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), {
          recursive: true,
        });
        writeFileSync(
          resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
          'export const live = true;\n',
          'utf8',
        );
        writeFileSync(
          resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'),
          'export const live = true;\n',
          'utf8',
        );
      });

      const spec = await withWorkspaceBundleLock(
        async ({ heldLockValue }) => await resolveCliTestLaunchSpec(
          {
            testDir: resolve(repoRoot, '.project'),
            env: {
              ...process.env,
              HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
              HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
              HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
            },
          },
          {
            repoRoot,
            snapshotDir,
            timeoutMs: 100,
            pollIntervalMs: 5,
          },
        ),
        {
          lockPath: resolveWorkspaceBundleLockPath(repoRoot),
          timeoutMs: 100,
          pollIntervalMs: 5,
        },
      );

      const publishedSnapshotDir = resolveSourceSnapshotDir(spec);
      expectCanonicalPublishedSourceSnapshotDir(publishedSnapshotDir, snapshotDir);
      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).toHaveBeenCalledTimes(1);
      expect(sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent).not.toHaveBeenCalled();
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain('--preserve-symlinks');
      expect(spec.args).toContain('--preserve-symlinks-main');
      expect(spec.args).toContain(resolve(publishedSnapshotDir, 'src', 'index.ts'));
      expect(existsSync(resolve(publishedSnapshotDir, 'scripts', 'claude_launcher_runtime.cjs'))).toBe(true);
      expect(existsSync(resolve(publishedSnapshotDir, 'tools', 'launch-helper.txt'))).toBe(true);
      expect(existsSync(resolve(publishedSnapshotDir, 'bin', 'launch-helper.txt'))).toBe(true);
      expect(
        existsSync(
          resolve(
            publishedSnapshotDir,
            'node_modules',
            '@happier-dev',
            'release-runtime',
            'dist',
            'github.js',
          ),
        ),
      ).toBe(true);
      const nodeModulesEntry = lstatSync(resolve(publishedSnapshotDir, 'node_modules'));
      expect(nodeModulesEntry.isSymbolicLink() || nodeModulesEntry.isDirectory()).toBe(true);
      expect(spec.env?.TSX_TSCONFIG_PATH).toBe(resolve(publishedSnapshotDir, 'tsconfig.json'));

      const unrelatedSnapshotDir = `${publishedSnapshotDir}-unrelated`;
      mkdirSync(unrelatedSnapshotDir, { recursive: true });
      const cleanup = spec.cleanup;
      expect(cleanup).toBeTypeOf('function');
      expect(existsSync(publishedSnapshotDir)).toBe(true);

      await cleanup?.();
      expect(existsSync(publishedSnapshotDir)).toBe(false);
      expect(existsSync(unrelatedSnapshotDir)).toBe(true);

      await cleanup?.();
      expect(existsSync(unrelatedSnapshotDir)).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('preserves post-publication launch and snapshot-cleanup failures together', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-post-publication-cleanup-failure-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev'), { recursive: true });
      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}\n', 'utf8');
      fsPromisesMock.rm.mockRejectedValueOnce(new Error('synthetic published snapshot cleanup failure'));

      let error: unknown;
      try {
        await resolveCliTestLaunchSpec(
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
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual(expect.arrayContaining([
        expect.stringContaining('CLI source entrypoint missing'),
        expect.stringContaining('synthetic published snapshot cleanup failure'),
      ]));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('publishes copy-mode source snapshots with an isolated first-party dependency closure', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-copy-closure-'));
    const snapshotDir = resolve(repoRoot, 'caller-selected-admission-snapshot');
    const livePackageDir = resolve(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'release-runtime',
    );

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(livePackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(livePackageDir, '.happier-plugin'), { recursive: true });
      mkdirSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist'),
        { recursive: true },
      );
      mkdirSync(resolve(repoRoot, 'packages', 'release-runtime', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'protocol', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'node_modules', 'ps-list'), { recursive: true });
      mkdirSync(resolve(snapshotDir, 'node_modules', '@happier-dev'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/cli',
          dependencies: { 'ps-list': '8.1.1' },
        }),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'),
        'module.exports = {};\n',
        'utf8',
      );
      writeFileSync(
        resolve(livePackageDir, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/release-runtime',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          exports: { '.': { default: './dist/index.js' } },
        }),
        'utf8',
      );
      writeFileSync(resolve(livePackageDir, 'dist', 'index.js'), 'export const value = "before";\n', 'utf8');
      writeFileSync(
        resolve(livePackageDir, '.happier-plugin', 'plugin.json'),
        '{"id":"happier.fixture"}\n',
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'release-runtime', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/release-runtime',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: {
            '@happier-dev/protocol': '0.0.0',
          },
        }),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'release-runtime', 'dist', 'index.js'),
        'export const value = "before";\n',
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
        }),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
        'export const protocol = true;\n',
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'protocol', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
        }),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js'),
        'export const protocol = true;\n',
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'node_modules', 'ps-list', 'package.json'),
        JSON.stringify({ name: 'ps-list', version: '8.1.1', main: 'index.js' }),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'node_modules', 'ps-list', 'index.js'),
        'export default async function psList() { return []; }\n',
        'utf8',
      );
      symlinkSync(
        livePackageDir,
        resolve(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

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

      const publishedSnapshotDir = resolveSourceSnapshotDir(spec);
      expectCanonicalPublishedSourceSnapshotDir(publishedSnapshotDir, snapshotDir);
      const publishedPackageDir = resolve(
        publishedSnapshotDir,
        'node_modules',
        '@happier-dev',
        'release-runtime',
      );
      expect(lstatSync(publishedPackageDir).isSymbolicLink()).toBe(false);
      expect(lstatSync(resolve(publishedSnapshotDir, 'src')).isSymbolicLink()).toBe(false);
      expect(lstatSync(resolve(publishedSnapshotDir, 'scripts')).isSymbolicLink()).toBe(false);
      expect(lstatSync(resolve(publishedSnapshotDir, 'tsconfig.json')).isSymbolicLink()).toBe(false);
      expect(
        lstatSync(resolve(publishedSnapshotDir, 'node_modules', 'ps-list')).isSymbolicLink(),
      ).toBe(false);
      expect(
        readFileSync(resolve(publishedSnapshotDir, 'node_modules', 'ps-list', 'index.js'), 'utf8'),
      ).toContain('psList');
      expect(
        readFileSync(resolve(publishedPackageDir, '.happier-plugin', 'plugin.json'), 'utf8'),
      ).toContain('happier.fixture');
      expect(readFileSync(resolve(publishedPackageDir, 'dist', 'index.js'), 'utf8')).toContain('"before"');

      writeFileSync(resolve(livePackageDir, 'dist', 'index.js'), 'export const value = "after";\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = "after";\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{"compilerOptions":{"strict":false}}\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'),
        'module.exports = { changed: true };\n',
        'utf8',
      );
      expect(readFileSync(resolve(publishedPackageDir, 'dist', 'index.js'), 'utf8')).toContain('"before"');
      expect(readFileSync(resolve(publishedSnapshotDir, 'src', 'index.ts'), 'utf8')).toContain('ok = true');
      expect(readFileSync(resolve(publishedSnapshotDir, 'tsconfig.json'), 'utf8')).toBe('{}');
      expect(
        readFileSync(resolve(publishedSnapshotDir, 'scripts', 'claude_launcher_runtime.cjs'), 'utf8'),
      ).toBe('module.exports = {};\n');
      const admission = JSON.parse(
        readFileSync(resolve(publishedSnapshotDir, '.cli-source-snapshot-admission.json'), 'utf8'),
      ) as {
        packages: Record<string, {
          dependencies: string[];
          outputs: Array<{ path: string; size: number; mtimeMs: number }>;
        }>;
      };
      expect(admission.packages['release-runtime']?.dependencies).toEqual(['protocol']);
      const admittedOutput = admission.packages['release-runtime']?.outputs.find(
        (output) => output.path === 'dist/index.js',
      );
      const publishedOutputStats = statSync(resolve(publishedPackageDir, 'dist', 'index.js'));
      expect(admittedOutput).toEqual({
        path: 'dist/index.js',
        size: publishedOutputStats.size,
        mtimeMs: publishedOutputStats.mtimeMs,
      });
      expect(
        readdirSync(dirname(publishedSnapshotDir)).filter((name) => name.includes('.source-snapshot-tmp.')),
      ).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('refuses copy publication when the canonical bundled projection check rejects changed package bytes', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-stale-bundled-projection-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');
    const workspacePackageDir = resolve(repoRoot, 'packages', 'plugins', 'pi');
    const bundledPackageDir = resolve(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugins-pi',
    );
    const generatedInventoryPath = resolve(
      repoRoot,
      'apps',
      'cli',
      'src',
      'plugins',
      'projection',
      'registry',
      'sources',
      'generatedBundledPluginArtifacts.ts',
    );
    const relativeArtifactPath = 'dist/index.js';
    const changedArtifactBytes = 'export const artifactByte = "b";\n';

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(bundledPackageDir, 'dist'), { recursive: true });
      mkdirSync(dirname(generatedInventoryPath), { recursive: true });
      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/cli',
          dependencies: { '@happier-dev/plugins-pi': '0.0.0' },
        }),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export {};\n', 'utf8');
      writeFileSync(
        resolve(workspacePackageDir, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/plugins-pi',
          main: `./${relativeArtifactPath}`,
        }),
        'utf8',
      );
      writeFileSync(resolve(workspacePackageDir, relativeArtifactPath), changedArtifactBytes, 'utf8');
      writeFileSync(
        resolve(bundledPackageDir, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/plugins-pi',
          main: `./${relativeArtifactPath}`,
        }),
        'utf8',
      );
      writeFileSync(resolve(bundledPackageDir, relativeArtifactPath), changedArtifactBytes, 'utf8');
      writeFileSync(
        generatedInventoryPath,
        [
          'export const generatedBundledPluginArtifacts = [',
          '  {',
          '    "packageName": "@happier-dev/plugins-pi",',
          '    "record": {',
          '      "files": [',
          `        { "relativePath": "${relativeArtifactPath}", "byteLength": ${changedArtifactBytes.length}, "digest": "sha256:stale" }`,
          '      ]',
          '    }',
          '  }',
          '] as const;',
          '',
        ].join('\n'),
        'utf8',
      );

      const runCommand = vi.fn(async (input: Readonly<{
        command: string;
        args: string[];
        cwd: string;
        env?: NodeJS.ProcessEnv;
      }>) => {
        expect(input).toMatchObject({
          command: process.execPath,
          args: [
            '--experimental-strip-types',
            resolve(repoRoot, 'scripts', 'migrations', 'extensions', 'generateBundledPluginEntries.ts'),
            '--root',
            repoRoot,
            '--mode',
            'check',
          ],
          cwd: repoRoot,
          env: expect.objectContaining({
            HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: expect.any(String),
          }),
        });
        expect(readdirSync(resolve(workspacePackageDir, 'dist'))).toEqual(['index.js']);
        expect(readdirSync(resolve(bundledPackageDir, 'dist'))).toEqual(['index.js']);
        expect(readFileSync(resolve(workspacePackageDir, relativeArtifactPath), 'utf8')).toBe(
          changedArtifactBytes,
        );
        expect(readFileSync(resolve(bundledPackageDir, relativeArtifactPath), 'utf8')).toBe(
          changedArtifactBytes,
        );
        expect(readFileSync(generatedInventoryPath, 'utf8')).toContain(
          `"relativePath": "${relativeArtifactPath}"`,
        );
        throw new Error(`Generated output differs: ${generatedInventoryPath}`);
      });

      let launchSpec: Awaited<ReturnType<typeof resolveCliTestLaunchSpec>> | undefined;
      let error: unknown;
      try {
        launchSpec = await resolveCliTestLaunchSpec(
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
            runCommand,
          },
        );
      } catch (caught) {
        error = caught;
      }

      expect({
        error: error instanceof Error ? error.message : null,
        launchSpecReturned: launchSpec !== undefined,
        publishedSnapshotDirs: readdirSync(repoRoot).filter((name) =>
          name.startsWith('cli-source-snapshot-source-')),
        canonicalCheckCalls: runCommand.mock.calls.length,
      }).toEqual({
        error: expect.stringContaining('Generated output differs'),
        launchSpecReturned: false,
        publishedSnapshotDirs: [],
        canonicalCheckCalls: 1,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('refuses freshness-bypassed copy publication when normal build mode leaves source-dev outputs stale', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-stale-freshness-bypass-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), {
        recursive: true,
      });
      mkdirSync(resolve(repoRoot, 'packages', 'release-runtime', 'dist'), { recursive: true });
      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export {};\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/release-runtime',
          main: './dist/index.js',
        }),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
        'export {};\n',
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'release-runtime', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/release-runtime',
          main: './dist/index.js',
        }),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'packages', 'release-runtime', 'dist', 'index.js'),
        'export {};\n',
        'utf8',
      );

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockClear();
      sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent.mockRejectedValueOnce(
        new Error('Source-dev CLI shared dependencies are not current'),
      );

      await expect(
        resolveCliTestLaunchSpec(
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
            skipSourceFreshnessCheck: true,
          },
        ),
      ).rejects.toThrow(/source-dev CLI shared dependencies are not current/i);

      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).toHaveBeenCalledTimes(1);
      expect(sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent).toHaveBeenCalledTimes(1);
      expect(
        readdirSync(repoRoot).filter((name) => name.startsWith('cli-source-snapshot-source-')),
      ).toEqual([]);
    } finally {
      sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent.mockReset();
      sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent.mockResolvedValue(undefined);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('refuses skip-build copy publication when the canonical source-dev currentness check is stale', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-stale-copy-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), {
        recursive: true,
      });
      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export {};\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/release-runtime',
          main: './dist/index.js',
        }),
        'utf8',
      );
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'index.js'),
        'export {};\n',
        'utf8',
      );

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockClear();
      sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent.mockRejectedValueOnce(
        new Error('Source-dev CLI shared dependencies are not current'),
      );

      await expect(
        resolveCliTestLaunchSpec(
          {
            testDir: resolve(repoRoot, '.project'),
            env: {
              ...process.env,
              HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
              HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
              HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
            },
          },
          {
            repoRoot,
            snapshotDir,
          },
        ),
      ).rejects.toThrow(/source-dev CLI shared dependencies are not current/i);

      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).toHaveBeenCalledTimes(1);
      expect(sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent).toHaveBeenCalledTimes(1);
      expect(
        readdirSync(repoRoot).filter((name) => name.startsWith('cli-source-snapshot-source-')),
      ).toEqual([]);
    } finally {
      sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent.mockReset();
      sharedDepsBuildMock.ensureCliSourceDevSharedDepsCurrent.mockResolvedValue(undefined);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('waits for an active workspace writer before publishing a skip-build copy snapshot', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-skip-'));
    const snapshotDir = resolve(repoRoot, 'caller-selected-currentness-snapshot');
    const buildLockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const buildLockContents = JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
    });

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'release-runtime', 'dist'), { recursive: true });
      mkdirSync(dirname(buildLockPath), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
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
      writeFileSync(buildLockPath, buildLockContents, 'utf8');

      sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockClear();

      let settled = false;
      const specPromise = resolveCliTestLaunchSpec(
        {
          testDir: resolve(repoRoot, '.project'),
          env: {
            ...process.env,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
          },
        },
        {
          repoRoot,
          snapshotDir,
          timeoutMs: 1_000,
          pollIntervalMs: 5,
        },
      ).finally(() => {
        settled = true;
      });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      expect(settled).toBe(false);
      expect(
        readdirSync(dirname(snapshotDir)).filter((name) => name.startsWith('cli-source-snapshot-source-')),
      ).toEqual([]);

      rmSync(buildLockPath, { force: true });
      const spec = await specPromise;

      const publishedSnapshotDir = resolveSourceSnapshotDir(spec);
      expectCanonicalPublishedSourceSnapshotDir(publishedSnapshotDir, snapshotDir);
      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).toHaveBeenCalledTimes(1);
      expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
          }),
        }),
        expect.any(Object),
      );
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain(resolve(publishedSnapshotDir, 'src', 'index.ts'));
      expect(existsSync(buildLockPath)).toBe(false);
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
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
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
      expect(lstatSync(resolve(snapshotDir, 'node_modules')).isDirectory()).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'scripts', 'claude_launcher_runtime.cjs'))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('overlays root and cli node_modules for source-entrypoint symlink snapshots', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-root-symlink-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'zod'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'node_modules', 'axios'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'zod', 'index.js'), 'export {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'node_modules', 'axios', 'index.js'), 'module.exports = {};\n', 'utf8');

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

      expect(spec.args).toContain(resolve(snapshotDir, 'src', 'index.ts'));
      expect(lstatSync(resolve(snapshotDir, 'node_modules')).isDirectory()).toBe(true);
      expect(lstatSync(resolve(snapshotDir, 'node_modules', 'axios')).isSymbolicLink()).toBe(true);
      expect(lstatSync(resolve(snapshotDir, 'node_modules', 'zod')).isSymbolicLink()).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'node_modules', 'axios', 'index.js'))).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'node_modules', 'zod', 'index.js'))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('replaces stale copied snapshot node_modules with a symlink when symlink mode is requested', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-symlink-replace-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'left-pad'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'left-pad', 'index.js'), 'module.exports = (v) => v;\n', 'utf8');

      mkdirSync(resolve(snapshotDir, 'node_modules', 'stale-only'), { recursive: true });
      writeFileSync(resolve(snapshotDir, 'node_modules', 'stale-only', 'index.js'), 'module.exports = "stale";\n', 'utf8');

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
      expect(lstatSync(resolve(snapshotDir, 'node_modules')).isDirectory()).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
      expect(existsSync(resolve(snapshotDir, 'node_modules', 'stale-only', 'index.js'))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('repairs incomplete existing snapshot node_modules for source-entrypoint launches', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-repair-'));
    const snapshotDir = resolve(repoRoot, 'snapshot');

    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'tools'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'agents', 'dist'), { recursive: true });
      mkdirSync(resolve(repoRoot, 'node_modules', 'zod'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'scripts', 'claude_launcher_runtime.cjs'), 'module.exports = {};\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tools', 'launch-helper.txt'), 'tools\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'bin', 'launch-helper.txt'), 'bin\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { zod: '4.3.6' },
        }, null, 2),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'agents', 'dist', 'index.js'), 'export {};\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'packages', 'agents', 'package.json'),
        JSON.stringify({
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { zod: '4.3.6' },
        }, null, 2),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'packages', 'agents', 'dist', 'index.js'), 'export {};\n', 'utf8');
      writeFileSync(
        resolve(repoRoot, 'node_modules', 'zod', 'package.json'),
        JSON.stringify({ name: 'zod', version: '4.3.6', main: 'index.js' }, null, 2),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'node_modules', 'zod', 'index.js'), 'export const repaired = "root";\n', 'utf8');

      mkdirSync(resolve(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4'), { recursive: true });
      writeFileSync(
        resolve(snapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'v4', 'index.js'),
        'export const partial = true;\n',
        'utf8',
      );

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

      const publishedSnapshotDir = resolveSourceSnapshotDir(spec);
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toContain(resolve(publishedSnapshotDir, 'src', 'index.ts'));
      expect(readFileSync(resolve(publishedSnapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'index.js'), 'utf8')).toContain(
        'repaired',
      );
      expect(readFileSync(resolve(publishedSnapshotDir, 'node_modules', '@happier-dev', 'agents', 'node_modules', 'zod', 'package.json'), 'utf8')).toContain(
        '"name": "zod"',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
