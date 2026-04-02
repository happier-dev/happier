import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureTauriWatcherIgnoreFile,
  ensureTauriSidecarEntrypointFile,
  ensureTauriSidecarRuntimeFiles,
  resolveBunTargetForTauriBuildEnv,
  resolveTauriWatcherIgnoreContent,
} from './prepareTauriSidecar.mjs';

test('prefers the Tauri target triple when resolving the bundled sidecar build target', () => {
  assert.equal(
    resolveBunTargetForTauriBuildEnv({
      TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin',
    }),
    'bun-darwin-arm64',
  );
});

test('falls back to TARGET when the Tauri env target triple is not present', () => {
  assert.equal(
    resolveBunTargetForTauriBuildEnv({
      TARGET: 'x86_64-pc-windows-msvc',
    }),
    'bun-windows-x64',
  );
});

test('returns null for unsupported target triples so the bootstrap build can fall back to host resolution', () => {
  assert.equal(
    resolveBunTargetForTauriBuildEnv({
      TAURI_ENV_TARGET_TRIPLE: 'armv7-linux-androideabi',
    }),
    null,
  );
});

test('prepareTauriSidecar builds app workspace dependencies before compiling hsetup', async () => {
  const calls = [];
  const ensureWorkspacePackagesBuiltForComponent = async (componentDir, options) => {
    calls.push(['ensure', componentDir, options]);
  };
  const ensureTauriSidecarRuntimeFilesImpl = async (options) => {
    calls.push(['runtime', options]);
    return [];
  };
  const ensureTauriSidecarEntrypointFileImpl = async (options) => {
    calls.push(['entrypoint', options]);
    return join(options.srcTauriDir, 'binaries', 'hsetup.js');
  };
  const spawnSyncImpl = (command, args, options) => {
    calls.push(['spawn', command, args, options]);
    return { status: 0 };
  };

  const { prepareTauriSidecar } = await import('./prepareTauriSidecar.mjs');

  const result = await prepareTauriSidecar({
    env: { TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin' },
    ensureWorkspacePackagesBuiltForComponent,
    ensureTauriSidecarRuntimeFilesImpl,
    ensureTauriSidecarEntrypointFileImpl,
    spawnSyncImpl,
  });

  assert.equal(result, 0);
  assert.equal(calls[0][0], 'ensure');
  assert.match(String(calls[0][1]), /apps\/ui$/);
  assert.equal(calls[1][0], 'ensure');
  assert.match(String(calls[1][1]), /apps\/bootstrap$/);
  assert.equal(calls[2][0], 'spawn');
  assert.equal(calls[2][1], 'yarn');
  assert.deepEqual(calls[2][2], ['-s', 'workspace', '@happier-dev/bootstrap', 'build:binary']);
  assert.equal(calls[2][3].env.HAPPIER_BUN_TARGET, 'bun-darwin-arm64');
  assert.equal(calls[3][0], 'runtime');
  assert.equal(calls[4][0], 'entrypoint');
});

test('prepareTauriSidecar invokes Yarn via a Windows-safe shell so yarn.cmd can be resolved', async () => {
  const calls = [];
  const ensureWorkspacePackagesBuiltForComponent = async () => {};
  const ensureTauriSidecarRuntimeFilesImpl = async () => [];
  const ensureTauriSidecarEntrypointFileImpl = async (options) => join(options.srcTauriDir, 'binaries', 'hsetup.js');
  const spawnSyncImpl = (command, args, options) => {
    calls.push(['spawn', command, args, options]);
    return { status: 0 };
  };

  const { prepareTauriSidecar } = await import('./prepareTauriSidecar.mjs');

  await prepareTauriSidecar({
    env: {},
    platform: 'win32',
    ensureWorkspacePackagesBuiltForComponent,
    ensureTauriSidecarRuntimeFilesImpl,
    ensureTauriSidecarEntrypointFileImpl,
    spawnSyncImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'spawn');
  assert.equal(calls[0][1], 'yarn');
  assert.deepEqual(calls[0][2], ['-s', 'workspace', '@happier-dev/bootstrap', 'build:binary']);
  assert.equal(calls[0][3].shell, true);
});

test('ensureTauriSidecarEntrypointFile copies the compiled hsetup JS companion next to the native wrapper', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'happier-tauri-sidecar-js-'));
  const bootstrapDistBinDir = join(rootDir, 'bootstrap', 'dist', 'bin');
  const srcTauriDir = join(rootDir, 'ui', 'src-tauri');
  await mkdir(join(bootstrapDistBinDir), { recursive: true });
  await mkdir(join(srcTauriDir), { recursive: true });

  const sourcePath = join(bootstrapDistBinDir, 'hsetup.js');
  const sourceContent = "export const runHsetupCli = () => 0;\n";
  await writeFile(sourcePath, sourceContent, 'utf8');

  const targetPath = await ensureTauriSidecarEntrypointFile({
    srcTauriDir,
    bootstrapDistBinDir,
  });

  assert.equal(targetPath, join(srcTauriDir, 'binaries', 'hsetup.js'));
  assert.equal(await readFile(targetPath, 'utf8'), sourceContent);
});

test('ensureTauriSidecarRuntimeFiles mirrors the bootstrap runtime directories used by the sidecar wrapper', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'happier-tauri-sidecar-runtime-'));
  const bootstrapDistDir = join(rootDir, 'bootstrap', 'dist');
  const srcTauriDir = join(rootDir, 'ui', 'src-tauri');
  await mkdir(join(bootstrapDistDir, 'systemTasks', 'kinds'), { recursive: true });
  await mkdir(join(bootstrapDistDir, 'ssh'), { recursive: true });
  await mkdir(join(bootstrapDistDir, 'integrations', 'tailscale'), { recursive: true });
  await mkdir(join(srcTauriDir), { recursive: true });

  await writeFile(join(bootstrapDistDir, 'systemTasks', 'registry.js'), 'export const registry = 1;\n', 'utf8');
  await writeFile(join(bootstrapDistDir, 'systemTasks', 'remoteSshBootstrapTasks.js'), 'export const runner = 1;\n', 'utf8');
  await writeFile(join(bootstrapDistDir, 'systemTasks', 'kinds', 'setupThisComputer.js'), 'export const setup = 1;\n', 'utf8');
  await writeFile(join(bootstrapDistDir, 'ssh', 'index.js'), 'export const ssh = 1;\n', 'utf8');
  await writeFile(join(bootstrapDistDir, 'integrations', 'tailscale', 'ensureTailscaleInstalled.js'), 'export const tailscale = 1;\n', 'utf8');

  const copied = await ensureTauriSidecarRuntimeFiles({
    srcTauriDir,
    bootstrapDistDir,
  });

  assert.deepEqual(copied.sort(), [
    join(srcTauriDir, 'integrations', 'tailscale'),
    join(srcTauriDir, 'ssh'),
    join(srcTauriDir, 'systemTasks'),
  ].sort());
  assert.equal(await readFile(join(srcTauriDir, 'systemTasks', 'registry.js'), 'utf8'), 'export const registry = 1;\n');
  assert.equal(await readFile(join(srcTauriDir, 'systemTasks', 'remoteSshBootstrapTasks.js'), 'utf8'), 'export const runner = 1;\n');
  assert.equal(await readFile(join(srcTauriDir, 'systemTasks', 'kinds', 'setupThisComputer.js'), 'utf8'), 'export const setup = 1;\n');
  assert.equal(await readFile(join(srcTauriDir, 'ssh', 'index.js'), 'utf8'), 'export const ssh = 1;\n');
  assert.equal(await readFile(join(srcTauriDir, 'integrations', 'tailscale', 'ensureTailscaleInstalled.js'), 'utf8'), 'export const tailscale = 1;\n');
});

test('prepareTauriSidecar propagates spawn errors', async () => {
  const boom = new Error('spawn failed');
  const { prepareTauriSidecar } = await import('./prepareTauriSidecar.mjs');

  await assert.rejects(() => prepareTauriSidecar({
    env: {},
    ensureWorkspacePackagesBuiltForComponent: async () => {},
    spawnSyncImpl: () => ({ error: boom }),
  }), /spawn failed/);
});

test('ensureTauriWatcherIgnoreFile adds the Tauri sidecar binaries directory to the ignore file', async () => {
  const srcTauriDir = await mkdtemp(join(tmpdir(), 'happier-tauri-ignore-'));

  await ensureTauriWatcherIgnoreFile({ srcTauriDir });

  const ignoreFile = await readFile(join(srcTauriDir, '.taurignore'), 'utf8');
  assert.match(ignoreFile, /(?:^|\n)binaries\/(?:\n|$)/);
});

test('resolveTauriWatcherIgnoreContent stays idempotent once the sidecar dir is already ignored', () => {
  assert.equal(resolveTauriWatcherIgnoreContent('binaries/\n'), null);
  assert.equal(resolveTauriWatcherIgnoreContent('# comment\nbinaries/\n'), null);
});
