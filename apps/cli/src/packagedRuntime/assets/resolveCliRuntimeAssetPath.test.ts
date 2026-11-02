import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FirstPartyVersionRootIdentityError } from '@happier-dev/cli-common/firstPartyRuntime';

import { withTempDir } from '@/testkit/fs/tempDir';
import { resolveAuthoritativePackagedRuntimeCustody, resolveAuthoritativePackagedRuntimeProjectRoot, resolvePackagedRuntimeEntrypoint } from '../resolvePackagedRuntimeEntrypoint';
import { resolveCliRuntimeAssetPathFromModuleUrl } from './resolveCliRuntimeAssetPath';

describe('resolveCliRuntimeAssetPath', () => {
  const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
  const originalArgv = [...process.argv];

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/projectPath');
    vi.unstubAllEnvs();
    process.argv = [...originalArgv];
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', originalExecPathDescriptor);
    }
  });

  it('reads sidecars and child entrypoints from the launched shim home and version', async () => {
    await withTempDir('happier-runtime-shim-home-', async (root) => {
      const shimHome = join(root, 'install');
      const stateHome = join(root, 'state');
      const ambientInstallHome = join(root, 'another-install');
      const versionRoot = join(shimHome, 'cli-preview', 'versions', 'version-a');
      const foreignRoot = join(ambientInstallHome, 'cli-preview', 'current');
      const binRoot = join(shimHome, 'bin');
      for (const runtimeRoot of [versionRoot, foreignRoot, binRoot]) {
        mkdirSync(join(runtimeRoot, 'scripts'), { recursive: true });
        mkdirSync(join(runtimeRoot, 'package-dist'), { recursive: true });
        writeFileSync(join(runtimeRoot, 'package-dist', 'index.mjs'), '');
        writeFileSync(join(runtimeRoot, 'package-dist', 'shim-test-child.mjs'), '');
        writeFileSync(join(runtimeRoot, 'scripts', 'session_hook_forwarder.cjs'), 'hook fixture');
      }
      writeFileSync(join(shimHome, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: 'preview' }));
      writeFileSync(join(shimHome, 'cli-preview', 'current.version'), 'version-a\n');
      vi.stubEnv('HAPPIER_HOME_DIR', stateHome);
      vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', ambientInstallHome);
      vi.stubEnv('HAPPIER_PUBLIC_RELEASE_CHANNEL', 'stable');
      const shim = join(shimHome, 'bin', 'happier.exe');
      Object.defineProperty(process, 'execPath', { ...originalExecPathDescriptor, value: shim });
      process.argv = [shim];
      // A self-contained bundle has no physical module path. Keep the real shim/layout
      // readers beneath that process boundary and deliberately omit the current junction.
      const moduleUrl = 'file:///$bunfs/root/happier';
      const asset = resolveCliRuntimeAssetPathFromModuleUrl(moduleUrl, 'scripts', 'session_hook_forwarder.cjs');
      const child = resolvePackagedRuntimeEntrypoint('shim-test-child.mjs', { moduleUrl });
      const authority = resolveAuthoritativePackagedRuntimeProjectRoot({ moduleUrl });
      expect({ asset, child, authority }).toEqual({
        asset: join(versionRoot, 'scripts', 'session_hook_forwarder.cjs'),
        child: join(versionRoot, 'package-dist', 'shim-test-child.mjs'),
        authority: { root: versionRoot, provenance: 'packaged-launch' },
      });
      expect(readFileSync(asset, 'utf8')).toBe('hook fixture');
      expect(resolveAuthoritativePackagedRuntimeCustody({ moduleUrl })).toEqual({
        root: versionRoot,
        packagedRuntime: { kind: 'cli_version_root', versionRootId: 'version-a' },
        provenance: 'packaged-launch',
      });

      // The loaded immutable module remains authoritative when an update or
      // channel choice moves the active pointers during this process's life.
      writeFileSync(join(shimHome, 'cli-preview', 'current.version'), 'version-b\n');
      writeFileSync(join(shimHome, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: 'stable' }));
      expect(resolveAuthoritativePackagedRuntimeCustody({
        moduleUrl: pathToFileURL(join(versionRoot, 'package-dist', 'chunk.js')).href,
      })).toEqual({
        root: versionRoot,
        packagedRuntime: { kind: 'cli_version_root', versionRootId: 'version-a' },
        provenance: 'packaged-module',
      });

      const unrelatedModuleRoot = join(root, 'outside-install', 'cli-preview', 'versions', 'version-a');
      mkdirSync(join(unrelatedModuleRoot, 'package-dist'), { recursive: true });
      expect(() => resolveAuthoritativePackagedRuntimeCustody({
        moduleUrl: pathToFileURL(join(unrelatedModuleRoot, 'package-dist', 'chunk.js')).href,
      })).toThrow(FirstPartyVersionRootIdentityError);
    });
  });

  it('uses the executable directory when running as a self-contained binary', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
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

  it('uses the admitted physical runtime root when Bun exposes only virtual process paths', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/$bunfs/root/happier',
      });
    }
    process.argv = ['/$bunfs/root/happier', '/$bunfs/root/happier', 'daemon', 'start'];
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', '1');
    vi.stubEnv(
      'HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT',
      '/runtime/builds/selected/cli/package-dist/index.mjs',
    );
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT', 'abcdef1234567890');

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('runtime-entrypoint.cjs')).toBe(
      '/runtime/builds/selected/cli/runtime-entrypoint.cjs',
    );
  });

  it('uses the admitted physical Windows runtime root when Bun embeds every process path', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => 'C:/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: 'C:\\~BUN\\root\\happier.exe',
      });
    }
    process.argv = ['C:\\~BUN\\root\\happier.exe', 'daemon', 'start'];
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', '1');
    vi.stubEnv(
      'HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT',
      'C:\\runtime\\payload\\package-dist\\index.mjs',
    );
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT', 'abcdef1234567890');

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('runtime-entrypoint.cjs')).toBe(
      'C:/runtime/payload/runtime-entrypoint.cjs',
    );
  });

  it('does not trust an unadmitted runtime entrypoint when Bun exposes only virtual process paths', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/$bunfs/root/happier',
      });
    }
    process.argv = ['/$bunfs/root/happier', '/$bunfs/root/happier', 'daemon', 'start'];
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', '1');
    vi.stubEnv(
      'HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT',
      '/runtime/builds/untrusted/cli/package-dist/index.mjs',
    );
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT', 'not-a-fingerprint');

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('runtime-entrypoint.cjs')).toBe(
      '/$bunfs/root/runtime-entrypoint.cjs',
    );
  });

  it('uses the project root when running under a JavaScript runtime', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
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

  it('uses the installed preview cli current payload when launched from the preview shim path', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
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

  it('uses the installed dev cli current payload when launched from the dev shim path', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/Users/test/.happier/bin/hdev',
      });
    }

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('tools', 'unpacked', 'zellij')).toBe(
      '/Users/test/.happier/cli-dev/current/tools/unpacked/zellij',
    );
  });
});
