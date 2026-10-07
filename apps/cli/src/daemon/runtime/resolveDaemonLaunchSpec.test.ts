import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH } from '@happier-dev/cli-common/bundledPluginPublicationPolicy';
import { PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH } from '@happier-dev/cli-common/pinnedRunnerSnapshot';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from '@happier-dev/cli-common/componentArtifacts/cliRuntimeSidecars';
import { withTempDir } from '@/testkit/fs/tempDir';
import { publishPinnedRunnerSnapshotFixture } from '@/testkit/process/spawnHappyCliHarness';

const {
  ensureJavaScriptRuntimeExecutableMock,
  resolvePackagedRuntimeEntrypointMock,
  resolveTsxImportHookSpecifierMock,
  resolveCliTsxTsconfigPathMock,
} = vi.hoisted(() => ({
  ensureJavaScriptRuntimeExecutableMock: vi.fn<typeof import('@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable').ensureJavaScriptRuntimeExecutable>(async () => '/usr/bin/node'),
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

vi.mock('@/utils/spawnHappyCLI', async () => {
  const actual = await vi.importActual<typeof import('@/utils/spawnHappyCLI')>('@/utils/spawnHappyCLI');
  return {
    ...actual,
    resolveTsxImportHookSpecifier: resolveTsxImportHookSpecifierMock,
    resolveCliTsxTsconfigPath: resolveCliTsxTsconfigPathMock,
  };
});

function writeAdmittedDaemonStartupClosure(root: string, marker = 'admitted'): Readonly<{
  entrypoint: string;
  fingerprint: string;
  runtimeStatePath: string;
  runtimeAssetIdentity: string;
}> {
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'chunk.mjs'), `export const marker = ${JSON.stringify(marker)};\n`, 'utf8');
  const entrypoint = join(distDir, 'index.mjs');
  writeFileSync(entrypoint, 'import "./chunk.mjs";\nexport {};\n', 'utf8');

  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  for (const relativePath of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const targetPath = join(scriptsDir, ...relativePath);
    if (relativePath[0] === 'runtime' || relativePath[0] === 'shims') {
      mkdirSync(targetPath, { recursive: true });
      continue;
    }
    writeFileSync(
      targetPath,
      `module.exports = ${JSON.stringify(relativePath.at(-1))};\n`,
      'utf8',
    );
  }
  const toolsDir = join(root, 'tools', 'unpacked');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
  const managedRuntimeBytes = 'managed-runtime-A';
  writeFileSync(
    join(root, ...PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH),
    managedRuntimeBytes,
    'utf8',
  );
  writeFileSync(join(root, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
  const failurePath = join(root, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH);
  mkdirSync(dirname(failurePath), { recursive: true });
  writeFileSync(failurePath, '[]\n');

  const written = cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
    outputDir: dirname(entrypoint),
    builtAt: '2026-07-26T00:00:00.000Z',
  });
  const { runtimeAsset } = cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
    runtimeRoot: root,
    entrypoint,
    relativePath: PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH.join('/'),
  });
  const fingerprint = written.manifest.fingerprint;
  const runtimeStatePath = join(root, 'stack.runtime.json');
  writeFileSync(runtimeStatePath, JSON.stringify({
    version: 1,
    stackName: 'qa-agent-1',
    daemon: {},
  }) + '\n', 'utf8');
  return { entrypoint, fingerprint, runtimeStatePath, runtimeAssetIdentity: runtimeAsset.sha256 };
}

describe('resolveDaemonLaunchSpec', () => {
  const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalExecPathDescriptor) Object.defineProperty(process, 'execPath', originalExecPathDescriptor);
    vi.unstubAllEnvs();
    vi.resetModules();
    delete process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
    delete process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
    delete process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX;
    delete process.env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT;
    delete process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT;
    delete process.env.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH;
    delete process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
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

  it('starts the initial stack daemon from its admitted pinned dist closure', async () => {
    await withTempDir('happier-daemon-launch-admitted-', async (root) => {
      const closure = writeAdmittedDaemonStartupClosure(root);
      process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
      process.env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT = closure.entrypoint;
      process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT = closure.fingerprint;
      process.env.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH = closure.runtimeStatePath;
      process.env.HAPPIER_STACK_STACK = 'qa-agent-1';
      process.env.HAPPIER_VARIANT = 'dev';

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync']);

      expect(result.filePath).toMatch(/[\\/]node(?:\.exe)?$/i);
      expect(result.args).toEqual(expect.arrayContaining([
        expect.stringMatching(
          /[\\/]\.runner-snapshots[\\/][a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{64}-package-dist-v7[\\/]package-dist[\\/]index\.mjs$/,
        ),
        'daemon',
        'start-sync',
      ]));
      expect(result.args).not.toContain('--import');
    });
  });

  it('bootstraps a cold admitted closure before native daemon launch and preserves acquisition failure', async () => {
    await withTempDir('happier-daemon-launch-cold-runtime-', async (root) => {
      const closure = writeAdmittedDaemonStartupClosure(join(root, 'closure'));
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPIER_HOME_DIR: join(root, 'home'),
        HAPPIER_JS_RUNTIME_PATH: '',
        HAPPIER_MANAGED_NODE_BIN: '',
        HAPPIER_NODE_PATH: '',
        PATH: '',
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: closure.entrypoint,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: closure.fingerprint,
        HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: closure.runtimeStatePath,
        HAPPIER_STACK_STACK: 'owned-cold-runtime',
      };
      // Exercise the real runtime resolver/bootstrap. Only the remote release
      // service and the native process identity are replaced at system boundaries.
      const runtime = await vi.importActual<typeof import('@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable')>(
        '@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable',
      );
      ensureJavaScriptRuntimeExecutableMock.mockImplementationOnce(runtime.ensureJavaScriptRuntimeExecutable);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
      Object.defineProperty(process, 'execPath', { value: join(root, 'happier'), configurable: true });

      const mod = await import('./resolveDaemonLaunchSpec');
      await expect(mod.resolveDaemonLaunchSpec(['daemon', 'start-sync'], environment)).rejects.toMatchObject({
        message: 'Managed JavaScript runtime is unavailable: bootstrap failed',
        cause: expect.objectContaining({ message: 'Failed to fetch Node release index (503)' }),
      });
    });
  });

  it('executes the admitted closure with the requested home runtime from a native launcher', async () => {
    await withTempDir('happier-daemon-launch-home-runtime-', async (root) => {
      const closure = writeAdmittedDaemonStartupClosure(join(root, 'closure'));
      const home = join(root, 'home');
      const current = join(home, 'tools', 'js-runtime', 'current');
      const nodeBinary = process.platform === 'win32'
        ? join(current, 'runtime', 'node.exe')
        : join(current, 'runtime', 'bin', 'node');
      const wrapper = join(current, 'bin', process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime');
      mkdirSync(dirname(nodeBinary), { recursive: true });
      mkdirSync(dirname(wrapper), { recursive: true });
      copyFileSync(process.execPath, nodeBinary);
      writeFileSync(wrapper, process.platform === 'win32'
        ? '@echo off\r\n"%~dp0..\\runtime\\node.exe" %*\r\n'
        : '#!/bin/sh\nexec "${0%/*}/../runtime/bin/node" "$@"\n');
      if (process.platform !== 'win32') {
        chmodSync(nodeBinary, 0o755);
        chmodSync(wrapper, 0o755);
      }
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPIER_HOME_DIR: home,
        HAPPIER_JS_RUNTIME_PATH: '',
        HAPPIER_MANAGED_NODE_BIN: '',
        HAPPIER_NODE_PATH: '',
        PATH: '',
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: closure.entrypoint,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: closure.fingerprint,
        HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: closure.runtimeStatePath,
        HAPPIER_STACK_STACK: 'owned-home-runtime',
      };
      const runtime = await vi.importActual<typeof import('@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable')>(
        '@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable',
      );
      ensureJavaScriptRuntimeExecutableMock.mockImplementationOnce(runtime.ensureJavaScriptRuntimeExecutable);
      vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', join(root, 'missing-parent-runtime'));
      Object.defineProperty(process, 'execPath', { value: join(root, 'happier'), configurable: true });

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync'], environment);
      expect(result.filePath).toBe(wrapper);
      expect(result.args).toContain('start-sync');
      expect(result.args.join(' ')).toContain(closure.fingerprint);
      // Run only the fixture's empty module, never a daemon or a user's stack.
      // The direct Node member is used on Windows because cmd wrappers require
      // the platform spawn adapter exercised by the adjacent detached suite.
      expect(execFileSync(process.platform === 'win32' ? nodeBinary : result.filePath, result.args, {
        env: { ...environment, ...result.env },
        encoding: 'utf8',
      })).toBe('');
      expect(process.env.HAPPIER_JS_RUNTIME_PATH).toBe(join(root, 'missing-parent-runtime'));
    });
  });

  it('resolves a self-restart from the successor environment instead of the incumbent process environment', async () => {
    await withTempDir('happier-daemon-launch-successor-', async (root) => {
      const incumbent = writeAdmittedDaemonStartupClosure(join(root, 'incumbent'), 'incumbent');
      const successor = writeAdmittedDaemonStartupClosure(join(root, 'successor'), 'successor');
      process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
      process.env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT = incumbent.entrypoint;
      process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT = incumbent.fingerprint;
      process.env.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH = incumbent.runtimeStatePath;
      process.env.HAPPIER_STACK_STACK = 'qa-agent-incumbent';
      process.env.HAPPIER_VARIANT = 'dev';

      const successorEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: successor.entrypoint,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: successor.fingerprint,
        HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: successor.runtimeStatePath,
        HAPPIER_STACK_STACK: 'qa-agent-successor',
      };

      const mod = await import('./resolveDaemonLaunchSpec');
      const result = await Reflect.apply(
        mod.resolveDaemonLaunchSpec,
        undefined,
        [['daemon', 'start-sync'], successorEnv],
      );

      expect(result.args).toEqual(expect.arrayContaining([
        expect.stringContaining(
          `.runner-snapshots${process.platform === 'win32' ? '\\' : '/'}${successor.fingerprint}-${successor.runtimeAssetIdentity}-`,
        ),
      ]));
      expect(result.args.join(' ')).not.toContain(incumbent.fingerprint);
    });
  });

  it('self-restarts a pinned Stack runner into the successor admitted closure instead of re-running itself', async () => {
    await withTempDir('happier-daemon-launch-pinned-successor-', async (root) => {
      // Stack starts a last-green runner directly from its snapshot with tsx disabled; the
      // successor fingerprint arrives later through the self-restart environment.
      const successor = writeAdmittedDaemonStartupClosure(join(root, 'successor'), 'successor');
      const { snapshotEntrypoint: incumbentRunnerEntrypoint } = publishPinnedRunnerSnapshotFixture({
        stagingRoot: join(root, '.runner-snapshots', '.incumbent-staging'),
        workspaceRuntimeIdentity: '3'.repeat(64),
      });
      const successorEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: successor.entrypoint,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: successor.fingerprint,
        HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: successor.runtimeStatePath,
        HAPPIER_STACK_STACK: 'qa-agent-successor',
      };
      const originalArgv = [...process.argv];
      try {
        process.argv = [process.execPath, incumbentRunnerEntrypoint, 'daemon', 'start-sync'];

        const mod = await import('./resolveDaemonLaunchSpec');
        const result = await mod.resolveDaemonLaunchSpec(['daemon', 'start-sync'], successorEnv);

        expect(result.args).toEqual(expect.arrayContaining([
          expect.stringContaining(
            `.runner-snapshots${process.platform === 'win32' ? '\\' : '/'}${successor.fingerprint}-`,
          ),
          'daemon',
          'start-sync',
        ]));
        expect(result.args).not.toContain(incumbentRunnerEntrypoint);
      } finally {
        process.argv = originalArgv;
      }
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
