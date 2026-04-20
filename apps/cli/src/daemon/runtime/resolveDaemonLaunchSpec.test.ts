import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  ensureJavaScriptRuntimeExecutableMock,
  resolvePackagedRuntimeEntrypointMock,
  resolveTsxImportHookPathMock,
  resolveCliTsxTsconfigPathMock,
} = vi.hoisted(() => ({
  ensureJavaScriptRuntimeExecutableMock: vi.fn<() => Promise<string | null>>(async () => '/usr/bin/node'),
  resolvePackagedRuntimeEntrypointMock: vi.fn(() => '/opt/happier/package-dist/index.mjs'),
  resolveTsxImportHookPathMock: vi.fn(() => '/opt/happier/node_modules/tsx/dist/esm/index.mjs'),
  resolveCliTsxTsconfigPathMock: vi.fn(() => '/opt/happier/apps/cli/tsconfig.json'),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('@/runtime/resolvePackagedRuntimeEntrypoint', () => ({
  resolvePackagedRuntimeEntrypoint: resolvePackagedRuntimeEntrypointMock,
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  resolveTsxImportHookPath: resolveTsxImportHookPathMock,
  resolveCliTsxTsconfigPath: resolveCliTsxTsconfigPathMock,
}));

describe('resolveDaemonLaunchSpec', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
  });

  it('reuses the current self-contained binary when running from a bundled Windows executable', async () => {
    const originalExecPath = process.execPath;
    const originalArgv = [...process.argv];

    try {
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\hq\\winsvc005-live\\happier-v0.2.4-windows-x64\\happier.exe',
        configurable: true,
      });
      process.argv = [
        'C:\\hq\\winsvc005-live\\happier-v0.2.4-windows-x64\\happier.exe',
        'B:/~BUN/root/happier.exe',
        'daemon',
        'start',
      ];

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

      expect(result).toEqual({
        filePath: 'C:\\hq\\winsvc005-live\\happier-v0.2.4-windows-x64\\happier.exe',
        args: ['daemon', 'start-sync'],
      });
      expect(ensureJavaScriptRuntimeExecutableMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: originalExecPath,
        configurable: true,
      });
      process.argv = originalArgv;
    }
  });

  it('forces a node-backed packaged entrypoint even when the parent process is bun', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => path === '/opt/happier/package-dist/index.mjs',
      };
    });

    const mod = await import('./resolveDaemonLaunchSpec');

    const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({
      isBunRuntime: false,
      currentExecPath: process.execPath,
    });
    expect(result).toEqual({
      filePath: '/usr/bin/node',
      args: ['--no-warnings', '--no-deprecation', '/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync'],
    });
  });

  it('falls back to tsx source entrypoint only when explicitly allowed', async () => {
    process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '1';
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => path.endsWith('src/index.ts'),
      };
    });

    const mod = await import('./resolveDaemonLaunchSpec');
    const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

    expect(result.filePath).toBe('/usr/bin/node');
    expect(result.args).toEqual([
      '--no-warnings',
      '--no-deprecation',
      '--import',
      '/opt/happier/node_modules/tsx/dist/esm/index.mjs',
      expect.stringMatching(/src\/index\.ts$/),
      'daemon',
      'start-sync',
    ]);
    expect(result.env).toEqual({
      TSX_TSCONFIG_PATH: '/opt/happier/apps/cli/tsconfig.json',
    });
  });

  it('fails closed when no node runtime can be resolved', async () => {
    ensureJavaScriptRuntimeExecutableMock.mockImplementationOnce(async () => null);

    const mod = await import('./resolveDaemonLaunchSpec');

    await expect(mod.resolveDaemonLaunchSpec(['daemon', 'start-sync'])).rejects.toThrow(
      /Daemon launch requires a JavaScript runtime/i,
    );
  });
});
