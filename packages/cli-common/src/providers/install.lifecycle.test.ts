import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withWorkspaceBundleLock } from '../../workspaceBundleLock.mjs';
import { installProviderCli } from './install.js';

describe('provider install operation lifecycle', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'happier-install-lifecycle-'));
    const command = join(root, process.platform === 'win32' ? 'runtime.exe' : 'runtime');
    await writeFile(command, 'fixture executable');
    await chmod(command, 0o755);
    env = { HAPPIER_HOME_DIR: root, PATH: '', HAPPIER_PNPM_BIN: command, HAPPIER_JS_RUNTIME_PATH: command };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not start an installation after the operation was cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('installation cancelled by caller'));
    const result = await installProviderCli({
      providerId: 'gemini', platform: 'linux', env, skipIfInstalled: false,
      signal: controller.signal,
      deps: { runCommand: async () => ({ kind: 'exited', status: 0, signal: null, stdout: '', stderr: '' }) },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'command-failed', errorMessage: 'installation cancelled by caller' });
    await expect(stat(join(root, 'tools', 'providers', 'gemini', 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels the package installer without activating its incomplete candidate', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel package installation');
    const result = await installProviderCli({
      providerId: 'gemini', platform: 'linux', env, skipIfInstalled: false,
      signal: controller.signal,
      deps: {
        // The package manager is an OS process boundary; bootstrap and installation stay real.
        runCommand: async ({ signal }) => {
          controller.abort(reason);
          return signal?.aborted
            ? { kind: 'aborted', error: reason, stdout: '', stderr: '' }
            : { kind: 'exited', status: 0, signal: null, stdout: '', stderr: '' };
        },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'command-failed', errorMessage: reason.message });
    await expect(stat(join(root, 'tools', 'providers', 'gemini', 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.logPath && await readFile(result.logPath, 'utf8')).toContain(reason.message);
  });

  it('cancels a real pnpm bootstrap lock wait through the public installer', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel pnpm bootstrap lock wait');
    const lockPath = join(root, 'tools', 'pnpm', '.lock', 'bootstrap.lock');
    let release!: () => void;
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const lockReleased = new Promise<void>((resolve) => { release = resolve; });
    const heldLock = withWorkspaceBundleLock(async () => {
      acquired();
      await lockReleased;
    }, { lockPath });
    await lockAcquired;
    try {
      const { HAPPIER_PNPM_BIN: _override, ...bootstrapEnv } = env;
      const result = await installProviderCli({
        providerId: 'gemini', platform: 'linux', env: bootstrapEnv, skipIfInstalled: false,
        signal: controller.signal,
        onProgress: (event) => {
          if (event.phase === 'waiting-for-lock') controller.abort(reason);
        },
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'command-failed', errorMessage: reason.message });
      expect(result.logPath && await readFile(result.logPath, 'utf8')).toContain('waiting-for-lock');
      // Cancellation of the waiter must not release the other process's lock.
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      release();
      await heldLock;
    }
  });

  it('logs binary download progress and cancellation without activating a partial download', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel binary download');
    const progress: string[] = [];
    const result = await installProviderCli({
      providerId: 'codex', platform: 'win32', env, skipIfInstalled: false,
      signal: controller.signal,
      onProgress: (event) => progress.push(event.phase),
      deps: {
        // GitHub release metadata and the asset stream are external network boundaries.
        fetchGitHubLatestRelease: async () => ({ assets: [{
          name: `codex-package-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc.tar.gz`,
          browser_download_url: 'https://example.invalid/codex.tar.gz', digest: 'sha256:fixture',
        }] }),
        downloadGitHubReleaseAsset: async ({ signal, onProgress }) => {
          for (let bytesDone = 1; bytesDone <= 1000; bytesDone++) onProgress?.({ bytesDone, bytesTotal: 1000 });
          controller.abort(reason);
          signal?.throwIfAborted();
          throw new Error('download did not receive operation cancellation');
        },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'command-failed', errorMessage: reason.message });
    expect(progress).toContain('downloading');
    const log = result.logPath ? await readFile(result.logPath, 'utf8') : '';
    expect(log).toContain('downloading');
    expect(log).toContain(reason.message);
    expect(log.split('\n').length).toBeLessThan(50);
    await expect(stat(join(root, 'tools', 'providers', 'codex', 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns the existing failure shape when a native updater is cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel native update');
    const command = join(root, '.local', 'share', 'claude', 'versions', '2.1.0');
    await mkdir(join(command, '..'), { recursive: true });
    await writeFile(command, 'native fixture');
    await chmod(command, 0o755);
    const result = await installProviderCli({
      providerId: 'claude', platform: 'linux', env: { ...env, HOME: root },
      intent: 'update', updateTarget: { command, source: 'system' }, allowVendorRecipeExecution: true,
      signal: controller.signal,
      deps: {
        runCommand: async ({ signal }) => {
          controller.abort(reason);
          return signal?.aborted
            ? { kind: 'aborted', error: reason, stdout: '', stderr: '' }
            : { kind: 'exited', status: 0, signal: null, stdout: '', stderr: '' };
        },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'command-failed', errorMessage: reason.message });
    expect(result.logPath && await readFile(result.logPath, 'utf8')).toContain(reason.message);
  });
});
