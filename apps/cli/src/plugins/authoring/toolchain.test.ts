import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PluginAuthorBundlerUnavailableError } from './bundleDaemonRuntime';
import {
  resolvePluginAuthorToolchainSpawnInvocation,
  resolveNativeTypeScriptBin,
  resolvePluginUiBuildBin,
  runPluginAuthorToolchain,
} from './toolchain';

function successfulSpawn() {
  return Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' });
}

describe('resolvePluginAuthorToolchainSpawnInvocation', () => {
  it('wraps the managed Windows JavaScript runtime command shim through cmd.exe', () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    try {
      const invocation = resolvePluginAuthorToolchainSpawnInvocation({
        command: 'C:\\Users\\Alice Smith\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd',
        args: ['C:\\plugin source\\node_modules\\@typescript\\native\\bin\\tsc.js', '--noEmit'],
        cwd: 'C:\\plugin source',
        env: {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          PATH: 'C:\\Windows\\System32',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
      });
      expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(invocation.args[3]).toContain('happier-js-runtime.cmd');
      expect(invocation.args[3]).toContain('@typescript');
      expect(invocation.cwd).toBe('C:\\plugin source');
      expect(invocation.windowsVerbatimArguments).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
});

describe('runPluginAuthorToolchain', () => {
  it('bundles the complete daemon dependency closure after a successful TypeScript build', async () => {
    const spawn = vi.fn(successfulSpawn);
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'build',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => null,
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation: 'build' });
    expect(bundlePluginDaemonRuntime).toHaveBeenCalledWith('/fixture/plugin');
  });

  it('reports an unavailable physical plugin bundler as a managed-tool diagnostic', async () => {
    const result = await runPluginAuthorToolchain({
      operation: 'build',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => null,
      bundlePluginDaemonRuntime: async () => {
        throw new PluginAuthorBundlerUnavailableError();
      },
      spawn: vi.fn(successfulSpawn),
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_author_managed_tool_unavailable',
      })],
    });
  });

  it('runs the project-local Plugin UI builder before bundling a build that declares a UI target', async () => {
    const spawn = vi.fn(successfulSpawn);
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'build',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => '/fixture/plugin/node_modules/@happier-dev/plugin-sdk/dist/ui/build/bin.js',
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation: 'build' });
    expect(spawn).toHaveBeenNthCalledWith(2, {
      command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      args: [
        '/fixture/plugin/node_modules/@happier-dev/plugin-sdk/dist/ui/build/bin.js',
        '--project-root',
        '/fixture/plugin',
      ],
      cwd: '/fixture/plugin',
      env: {},
    });
    expect(spawn.mock.invocationCallOrder[1]).toBeLessThan(
      bundlePluginDaemonRuntime.mock.invocationCallOrder[0]!,
    );
  });

  it('does not publish a daemon bundle when the declared Plugin UI build fails', async () => {
    const spawn = vi.fn()
      .mockImplementationOnce(successfulSpawn)
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'invalid Plugin UI target',
      });
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'build',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => '/fixture/plugin/node_modules/@happier-dev/plugin-sdk/dist/ui/build/bin.js',
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_author_tool_failed',
        message: expect.stringContaining('invalid Plugin UI target'),
      })],
    });
    expect(bundlePluginDaemonRuntime).not.toHaveBeenCalled();
  });

  it('installs dependencies through the canonical managed pnpm owner with fixture-scoped registry configuration', async () => {
    const spawn = vi.fn(successfulSpawn);
    const controller = new AbortController();
    const result = await runPluginAuthorToolchain({
      operation: 'install',
      projectRoot: '/fixture/plugin',
      sdkRegistryOrigin: 'http://127.0.0.1:43127',
      signal: controller.signal,
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env) => ({ ...env, PNPM_HOME: '/happier/tools/pnpm/home' }),
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv: { PATH: '/usr/bin' },
    });

    expect(result).toMatchObject({ ok: true, operation: 'install' });
    expect(spawn).toHaveBeenCalledWith({
      command: '/happier/tools/pnpm/current/bin/pnpm',
      args: [
        'install',
        '--ignore-scripts',
        '--config.@happier-dev:registry=http://127.0.0.1:43127',
      ],
      cwd: '/fixture/plugin',
      env: expect.objectContaining({ PNPM_HOME: '/happier/tools/pnpm/home' }),
      signal: controller.signal,
    });
  });

  it('uses the package manager default registry when no SDK registry override is supplied', async () => {
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation: 'install',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation: 'install' });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      args: ['install', '--ignore-scripts'],
    }));
  });

  it.each([
    ['typecheck', ['--noEmit', '-p', 'tsconfig.json']],
    ['build', ['-p', 'tsconfig.json']],
  ] as const)('runs %s through the managed JavaScript runtime and project-local TypeScript 7 entrypoint', async (operation, compilerArgs) => {
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation,
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      resolvePluginUiBuildBin: () => null,
      bundlePluginDaemonRuntime: async () => undefined,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation });
    expect(spawn).toHaveBeenCalledWith({
      command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      args: ['/fixture/plugin/node_modules/@typescript/native/bin/tsc', ...compilerArgs],
      cwd: '/fixture/plugin',
      env: {},
    });
  });

  it('compiles and rebundles a fresh scaffold before running its focused test through the managed JavaScript runtime', async () => {
    const spawn = vi.fn(successfulSpawn);
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'test',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({ ok: true, operation: 'test' });
    expect(spawn.mock.calls).toEqual([
      [{
        command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        args: ['/fixture/plugin/node_modules/@typescript/native/bin/tsc', '-p', 'tsconfig.json'],
        cwd: '/fixture/plugin',
        env: {},
      }],
      [{
        command: '/happier/tools/js-runtime/current/bin/happier-js-runtime',
        args: ['--test', 'test/index.test.mjs'],
        cwd: '/fixture/plugin',
        env: {},
      }],
    ]);
    expect(bundlePluginDaemonRuntime).toHaveBeenCalledWith('/fixture/plugin');
    expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(
      bundlePluginDaemonRuntime.mock.invocationCallOrder[0]!,
    );
    expect(bundlePluginDaemonRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      spawn.mock.invocationCallOrder[1]!,
    );
  });

  it('does not bundle or run a stale generated suite when the fresh scaffold compile fails', async () => {
    const spawn = vi.fn(async () => ({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'TypeScript compilation failed',
    }));
    const bundlePluginDaemonRuntime = vi.fn(async () => undefined);
    const result = await runPluginAuthorToolchain({
      operation: 'test',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      bundlePluginDaemonRuntime,
      spawn,
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      operation: 'test',
      diagnostics: [{
        code: 'plugin_author_tool_failed',
        message: expect.stringContaining('TypeScript compilation failed'),
      }],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(bundlePluginDaemonRuntime).not.toHaveBeenCalled();
  });

  it('fails closed when a managed tool is unavailable', async () => {
    const result = await runPluginAuthorToolchain({
      operation: 'install',
      projectRoot: '/fixture/plugin',
      sdkRegistryOrigin: 'http://127.0.0.1:43127',
    }, {
      ensureManagedPnpmCommand: async () => null,
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => null,
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn: vi.fn(successfulSpawn),
      processEnv: {},
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_author_managed_tool_unavailable' })],
    });
  });

  it('rejects a PATH pnpm fallback instead of assuming a system package manager', async () => {
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation: 'install',
      projectRoot: '/fixture/plugin',
      sdkRegistryOrigin: 'http://127.0.0.1:43127',
    }, {
      ensureManagedPnpmCommand: async () => '/usr/local/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv: { PATH: '/usr/local/bin:/usr/bin' },
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_author_managed_tool_unavailable' })],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects the host process Node executable instead of assuming a system runtime', async () => {
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation: 'typecheck',
      projectRoot: '/fixture/plugin',
    }, {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/usr/bin/node',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv: { PATH: '/usr/bin' },
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_author_managed_tool_unavailable' })],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'pnpm',
      operation: 'install' as const,
      processEnv: { HAPPIER_PNPM_BIN: '/usr/local/bin/pnpm' },
      sdkRegistryOrigin: 'http://127.0.0.1:43127',
    },
    {
      label: 'JavaScript runtime',
      operation: 'typecheck' as const,
      processEnv: { HAPPIER_NODE_PATH: '/usr/bin/node' },
      sdkRegistryOrigin: undefined,
    },
  ])('rejects an explicit host $label override as proof of managed ownership', async ({ operation, processEnv, sdkRegistryOrigin }) => {
    const hostCommand = operation === 'install' ? processEnv.HAPPIER_PNPM_BIN : processEnv.HAPPIER_NODE_PATH;
    const spawn = vi.fn(successfulSpawn);
    const result = await runPluginAuthorToolchain({
      operation,
      projectRoot: '/fixture/plugin',
      sdkRegistryOrigin,
    }, {
      ensureManagedPnpmCommand: async () => hostCommand ?? '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => hostCommand ?? '/happier/tools/js-runtime/current/bin/happier-js-runtime',
      resolveNativeTypeScriptBin: () => '/fixture/plugin/node_modules/@typescript/native/bin/tsc',
      spawn,
      processEnv,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_author_managed_tool_unavailable' })],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a TypeScript package bin that escapes the installed @typescript/native package', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-typescript-bin-'));
    const packageRoot = join(projectRoot, 'node_modules', '@typescript', 'native');
    try {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native',
        version: '7.0.2',
        bin: { tsc: '../../../outside.js' },
      }), 'utf8');

      expect(() => resolveNativeTypeScriptBin(projectRoot)).toThrow(/inside.*@typescript\/native/u);

      const outsideCompilerPath = join(projectRoot, 'outside.js');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      await writeFile(outsideCompilerPath, '', 'utf8');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native',
        version: '7.0.2',
        bin: { tsc: './bin/tsc' },
      }), 'utf8');
      await symlink(outsideCompilerPath, join(packageRoot, 'bin', 'tsc'));
      expect(() => resolveNativeTypeScriptBin(projectRoot)).toThrow(/contained regular file/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects an ancestor or non-TypeScript-7 @typescript/native package', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-author-typescript-owner-'));
    const projectRoot = join(parentRoot, 'plugin');
    const ancestorPackageRoot = join(parentRoot, 'node_modules', '@typescript', 'native');
    try {
      await mkdir(projectRoot, { recursive: true });
      await mkdir(join(ancestorPackageRoot, 'bin'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
      await writeFile(join(ancestorPackageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native',
        version: '7.0.2',
        bin: { tsc: './bin/tsc' },
      }), 'utf8');
      await writeFile(join(ancestorPackageRoot, 'bin', 'tsc'), '', 'utf8');
      expect(() => resolveNativeTypeScriptBin(projectRoot)).toThrow(/project-local/u);

      const versionProjectRoot = join(parentRoot, 'plugin-version');
      const localPackageRoot = join(versionProjectRoot, 'node_modules', '@typescript', 'native');
      await mkdir(join(localPackageRoot, 'bin'), { recursive: true });
      await writeFile(join(versionProjectRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
      await writeFile(join(localPackageRoot, 'package.json'), JSON.stringify({
        name: '@typescript/native',
        version: '6.9.9',
        bin: { tsc: './bin/tsc' },
      }), 'utf8');
      await writeFile(join(localPackageRoot, 'bin', 'tsc'), '', 'utf8');
      expect(() => resolveNativeTypeScriptBin(versionProjectRoot)).toThrow(/TypeScript 7/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('resolves the declared Plugin UI builder only from the project-local SDK package', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-ui-builder-'));
    const packageRoot = join(projectRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    try {
      await mkdir(join(packageRoot, 'dist', 'ui', 'build'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        scripts: { build: 'happier plugins author build .' },
      }), 'utf8');
      await writeFile(
        join(projectRoot, 'pluginUiBuild.mjs'),
        'export default { targets: [] };\n',
        'utf8',
      );
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        bin: { 'happier-plugin-build-ui': './dist/ui/build/bin.js' },
      }), 'utf8');
      const expectedBuilder = join(packageRoot, 'dist', 'ui', 'build', 'bin.js');
      await writeFile(expectedBuilder, 'export {};\n', 'utf8');

      expect(resolvePluginUiBuildBin(projectRoot)).toBe(await realpath(expectedBuilder));

      const outsideBuilder = join(projectRoot, 'outside-builder.js');
      await writeFile(outsideBuilder, 'export {};\n', 'utf8');
      await rm(expectedBuilder);
      await symlink(outsideBuilder, expectedBuilder);
      expect(() => resolvePluginUiBuildBin(projectRoot)).toThrow(/contained regular file/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not require the Plugin UI builder when the project declares no UI build target', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-author-no-ui-builder-'));
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        scripts: {
          build: 'happier plugins author build .',
          'build:ui': 'unrelated-company-ui-builder',
        },
      }), 'utf8');

      expect(resolvePluginUiBuildBin(projectRoot)).toBeNull();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
