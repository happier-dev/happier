import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { resolveCliRuntimeAssetPathFromModuleUrl } from './resolveCliRuntimeAssetPath';

describe('resolveCliRuntimeAssetPath', () => {
  const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/projectPath');
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', originalExecPathDescriptor);
    }
  });

  it('uses the executable directory when running as a self-contained binary', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
      projectPathFromModuleUrl: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/runtime/payload/happier',
      });
    }

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('scripts', 'claude_local_launcher.cjs')).toBe(
      '/runtime/payload/scripts/claude_local_launcher.cjs',
    );
  });

  it('uses the project root when running under a JavaScript runtime', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
      projectPathFromModuleUrl: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/usr/local/bin/node',
      });
    }

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('scripts', 'claude_local_launcher.cjs')).toBe(
      '/repo/apps/cli/scripts/claude_local_launcher.cjs',
    );
  });

  it('uses the installed cli current payload when launched from the stable shim path', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
      projectPathFromModuleUrl: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/Users/test/.happier/bin/happier',
      });
    }

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('scripts', 'claude_local_launcher.cjs')).toBe(
      '/Users/test/.happier/cli/current/scripts/claude_local_launcher.cjs',
    );
  });

  it('follows the default release channel when launched from the default happier shim path', async () => {
    await withTempDir('happier-runtime-assets-default-shim-', async (root) => {
      const happierHomeDir = join(root, '.happier');
      mkdirSync(join(happierHomeDir, 'bin'), { recursive: true });
      writeFileSync(
        join(happierHomeDir, 'default-cli-release-channel.json'),
        `${JSON.stringify({ releaseChannel: 'preview' })}\n`,
        'utf8',
      );
      vi.doMock('@/projectPath', () => ({
        projectPath: () => '/repo/apps/cli',
        projectPathFromModuleUrl: () => '/repo/apps/cli',
      }));
      if (originalExecPathDescriptor) {
        Object.defineProperty(process, 'execPath', {
          ...originalExecPathDescriptor,
          value: join(happierHomeDir, 'bin', 'happier.exe'),
        });
      }

      const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

      expect(resolveCliRuntimeAssetPath('scripts', 'session_hook_forwarder.cjs')).toBe(
        join(happierHomeDir, 'cli-preview', 'current', 'scripts', 'session_hook_forwarder.cjs'),
      );
    });
  });

  it('uses the installed preview cli current payload when launched from the preview shim path', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
      projectPathFromModuleUrl: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/Users/test/.happier/bin/hprev',
      });
    }

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('tools', 'unpacked', 'zellij')).toBe(
      '/Users/test/.happier/cli-preview/current/tools/unpacked/zellij',
    );
  });
});

describe('resolveCliRuntimeAssetPathFromModuleUrl', () => {
  it('resolves launch sidecars from a snapshot module root', async () => {
    await withTempDir('happier-runtime-assets-snapshot-', async (root) => {
      const snapshotRoot = join(root, '.runner-snapshots', 'abc123def4567890');
      const scriptsDir = join(snapshotRoot, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      for (const scriptName of [
        'terminal_launch_spec_runner.cjs',
        'claude_local_launcher.cjs',
        'env-wrapper.cjs',
      ]) {
        writeFileSync(join(scriptsDir, scriptName), 'module.exports = {};\n', 'utf8');
      }

      const moduleUrl = pathToFileURL(join(snapshotRoot, 'api-test.mjs')).href;

      for (const scriptName of [
        'terminal_launch_spec_runner.cjs',
        'claude_local_launcher.cjs',
        'env-wrapper.cjs',
      ]) {
        const resolved = resolveCliRuntimeAssetPathFromModuleUrl(moduleUrl, 'scripts', scriptName);
        expect(resolved).toBe(join(snapshotRoot, 'scripts', scriptName));
        expect(existsSync(resolved)).toBe(true);
      }
    });
  });

  it('keeps source and normal dist launches anchored at the CLI package root', () => {
    const sourceResolved = resolveCliRuntimeAssetPathFromModuleUrl(
      pathToFileURL(join(process.cwd(), 'src', 'runtime', 'assets', 'resolveCliRuntimeAssetPath.ts')).href,
      'scripts',
      'terminal_launch_spec_runner.cjs',
    );
    const distResolved = resolveCliRuntimeAssetPathFromModuleUrl(
      pathToFileURL(join(process.cwd(), 'dist', 'api-test.mjs')).href,
      'scripts',
      'terminal_launch_spec_runner.cjs',
    );

    expect(sourceResolved).toBe(join(process.cwd(), 'scripts', 'terminal_launch_spec_runner.cjs'));
    expect(distResolved).toBe(join(process.cwd(), 'scripts', 'terminal_launch_spec_runner.cjs'));
  });
});
