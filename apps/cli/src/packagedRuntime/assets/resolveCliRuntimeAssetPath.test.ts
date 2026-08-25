import { afterEach, describe, expect, it, vi } from 'vitest';

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
