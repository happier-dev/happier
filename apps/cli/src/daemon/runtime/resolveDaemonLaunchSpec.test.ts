import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  ensureJavaScriptRuntimeExecutableMock,
  resolvePackagedRuntimeEntrypointMock,
  resolveTsxImportHookSpecifierMock,
  resolveCliTsxTsconfigPathMock,
} = vi.hoisted(() => ({
  ensureJavaScriptRuntimeExecutableMock: vi.fn<() => Promise<string | null>>(async () => '/usr/bin/node'),
  resolvePackagedRuntimeEntrypointMock: vi.fn(() => '/opt/happier/package-dist/index.mjs'),
  resolveTsxImportHookSpecifierMock: vi.fn(() => '/opt/happier/node_modules/tsx/dist/esm/index.mjs'),
  resolveCliTsxTsconfigPathMock: vi.fn(() => '/opt/happier/apps/cli/tsconfig.json'),
}));

vi.mock('@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('@/packagedRuntime/resolvePackagedRuntimeEntrypoint', () => ({
  resolvePackagedRuntimeEntrypoint: resolvePackagedRuntimeEntrypointMock,
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  resolveTsxImportHookSpecifier: resolveTsxImportHookSpecifierMock,
  resolveCliTsxTsconfigPath: resolveCliTsxTsconfigPathMock,
}));

describe('resolveDaemonLaunchSpec', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
    delete process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
    delete process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX;
    delete process.env.HAPPIER_STACK_REPO_DIR;
    delete process.env.HAPPIER_STACK_CLI_ROOT_DIR;
    delete process.env.HAPPIER_STACK_STACK;
    delete process.env.HAPPIER_VARIANT;
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

  it('reuses the current runtime executable when launched from a packaged entrypoint under a managed JS runtime wrapper', async () => {
    const originalExecPath = process.execPath;
    const originalArgv = [...process.argv];

    try {
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\Users\\test_qa\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
        configurable: true,
      });
      process.argv = [
        'happier',
        'C:\\Users\\test_qa\\.happier\\cli-preview\\versions\\0.2.8\\package-dist\\index.mjs',
        'daemon',
        'restart',
      ];

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

      expect(result).toEqual({
        filePath: 'C:\\Users\\test_qa\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
        args: ['C:\\Users\\test_qa\\.happier\\cli-preview\\versions\\0.2.8\\package-dist\\index.mjs', 'daemon', 'start-sync'],
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

  it('does not reuse the embedded Bun virtual script path on Windows when resolving detached daemon launch', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => path === '/opt/happier/package-dist/index.mjs',
      };
    });

    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalExecPath = process.execPath;
    const originalArgv = [...process.argv];

    try {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\Program Files\\Bun\\bun.exe',
        configurable: true,
      });
      process.argv = [
        'bun',
        'B:/~BUN/root/happier.exe',
        'daemon',
        'start',
      ];

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

      expect(result).toEqual({
        filePath: '/usr/bin/node',
        args: ['--no-warnings', '--no-deprecation', '/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync'],
      });
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: originalExecPath,
        configurable: true,
      });
      process.argv = originalArgv;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }
  });

  it('does not launch detached daemons from an embedded bun virtual packaged entrypoint on Windows', async () => {
    process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '1';
    resolvePackagedRuntimeEntrypointMock.mockReturnValueOnce('B:/~BUN/root/package-dist/index.mjs');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => (
          path.replaceAll('\\', '/').endsWith('/src/index.ts')
          || path === 'B:/~BUN/root/package-dist/index.mjs'
        ),
      };
    });

    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalExecPath = process.execPath;
    const originalArgv = [...process.argv];

    try {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\Program Files\\Bun\\bun.exe',
        configurable: true,
      });
      process.argv = ['bun', 'B:/~BUN/root/happier.exe', 'daemon', 'start'];

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

      expect(result.filePath).toBe('/usr/bin/node');
      expect(result.args).toEqual([
        '--no-warnings',
        '--no-deprecation',
        '--import',
        '/opt/happier/node_modules/tsx/dist/esm/index.mjs',
        expect.stringMatching(/src[\\/]index\.ts$/),
        'daemon',
        'start-sync',
      ]);
      expect(result.args).not.toEqual(expect.arrayContaining(['B:/~BUN/root/package-dist/index.mjs']));
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: originalExecPath,
        configurable: true,
      });
      process.argv = originalArgv;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }
  });

  it('prefers the installed Windows packaged binary when launched under bun with an embedded bundle argv path', async () => {
    resolvePackagedRuntimeEntrypointMock.mockReturnValueOnce(
      'C:\\Users\\test\\.happier\\cli-preview\\versions\\0.2.6-preview.9\\package-dist\\index.mjs',
    );
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => {
          const normalized = path.replaceAll('\\', '/');
          return normalized === 'C:/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/package-dist/index.mjs'
            || normalized === 'C:/Users/test/.happier/cli-preview/versions/0.2.6-preview.9/happier.exe';
        },
      };
    });

    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalExecPath = process.execPath;
    const originalArgv = [...process.argv];

    try {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\Program Files\\Bun\\bun.exe',
        configurable: true,
      });
      process.argv = ['bun', 'B:/~BUN/root/happier.exe', 'daemon', 'start'];

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

      expect(result).toEqual({
        filePath: 'C:\\Users\\test\\.happier\\cli-preview\\versions\\0.2.6-preview.9\\happier.exe',
        args: ['daemon', 'start-sync'],
      });
      expect(ensureJavaScriptRuntimeExecutableMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: originalExecPath,
        configurable: true,
      });
      process.argv = originalArgv;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
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

  it('prefers the source entrypoint in stack context even when a packaged entrypoint exists', async () => {
    process.env.HAPPIER_STACK_REPO_DIR = '/repo';
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => (
          path === '/opt/happier/package-dist/index.mjs'
          || path.replaceAll('\\', '/').endsWith('/src/index.ts')
        ),
      };
    });

    const mod = await import('./resolveDaemonLaunchSpec');
    const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

    expect(result).toEqual({
      filePath: '/usr/bin/node',
      args: [
        '--no-warnings',
        '--no-deprecation',
        '--import',
        '/opt/happier/node_modules/tsx/dist/esm/index.mjs',
        expect.stringMatching(/src[\\/]index\.ts$/),
        'daemon',
        'start-sync',
      ],
      env: {
        TSX_TSCONFIG_PATH: '/opt/happier/apps/cli/tsconfig.json',
      },
    });
  });

  it('does not reuse the current packaged entrypoint when stack context prefers source launch', async () => {
    process.env.HAPPIER_STACK_REPO_DIR = '/repo';
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => (
          path === '/opt/happier/package-dist/index.mjs'
          || path.replaceAll('\\', '/').endsWith('/src/index.ts')
        ),
      };
    });

    const originalExecPath = process.execPath;
    const originalArgv = [...process.argv];

    try {
      Object.defineProperty(process, 'execPath', {
        value: '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
        configurable: true,
      });
      process.argv = [
        'happier',
        '/opt/happier/package-dist/index.mjs',
        'daemon',
        'restart',
      ];

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

      expect(result).toEqual({
        filePath: '/usr/bin/node',
        args: [
          '--no-warnings',
          '--no-deprecation',
          '--import',
          '/opt/happier/node_modules/tsx/dist/esm/index.mjs',
          expect.stringMatching(/src[\\/]index\.ts$/),
          'daemon',
          'start-sync',
        ],
        env: {
          TSX_TSCONFIG_PATH: '/opt/happier/apps/cli/tsconfig.json',
        },
      });
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: originalExecPath,
        configurable: true,
      });
      process.argv = originalArgv;
    }
  });

  it('falls back to tsx source entrypoint only when explicitly allowed', async () => {
    process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '1';
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => path.replaceAll('\\', '/').endsWith('src/index.ts'),
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
      expect.stringMatching(/src[\\/]index\.ts$/),
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
