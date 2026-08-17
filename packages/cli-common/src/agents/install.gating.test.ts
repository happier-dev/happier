import { describe, expect, it, vi } from 'vitest';
import { spawnSync as spawnSyncProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { installAgentCli, planAgentCliInstallForRuntime, resolvePlatformFromNodePlatform } from './install.js';

function expectedOhMyPiReleaseAssetName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'omp-darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'omp-darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'omp-linux-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'omp-linux-x64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'omp-windows-x64.exe';
  return null;
}

function expectedCodexReleaseAssetName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'codex-package-aarch64-apple-darwin.tar.gz';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'codex-package-x86_64-apple-darwin.tar.gz';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'codex-package-aarch64-unknown-linux-musl.tar.gz';
  if (process.platform === 'linux' && process.arch === 'x64') return 'codex-package-x86_64-unknown-linux-musl.tar.gz';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'codex-package-aarch64-pc-windows-msvc.tar.gz';
  if (process.platform === 'win32' && process.arch === 'x64') return 'codex-package-x86_64-pc-windows-msvc.tar.gz';
  return null;
}

function expectedCodexArchiveEntries() {
  if (process.platform === 'win32') {
    return [
      { archivePath: 'bin/codex.exe', destinationPath: 'bin/codex.exe' },
      { archivePath: 'bin/codex-code-mode-host.exe', destinationPath: 'bin/codex-code-mode-host.exe' },
      {
        archivePath: 'codex-resources/codex-command-runner.exe',
        destinationPath: 'codex-resources/codex-command-runner.exe',
      },
      {
        archivePath: 'codex-resources/codex-windows-sandbox-setup.exe',
        destinationPath: 'codex-resources/codex-windows-sandbox-setup.exe',
      },
    ];
  }
  return [
    { archivePath: 'bin/codex', destinationPath: 'bin/codex' },
    { archivePath: 'bin/codex-code-mode-host', destinationPath: 'bin/codex-code-mode-host' },
  ];
}

async function materializeDeclaredArchiveEntries(params: Readonly<{
  outputDir?: string;
  archiveEntries?: ReadonlyArray<Readonly<{ archivePath: string; destinationPath: string }>>;
}>): Promise<void> {
  if (!params.outputDir || !params.archiveEntries) throw new Error('Expected a declared archive layout');
  for (const entry of params.archiveEntries) {
    const destinationPath = join(params.outputDir, ...entry.destinationPath.split('/'));
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, '#!/bin/sh\nexit 0\n', 'utf8');
  }
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');

describe('installAgentCli vendor_recipe execution gating', () => {
  it('uses install guide URLs as install-plan documentation when docsUrl is absent', () => {
    const res = planAgentCliInstallForRuntime({
      runtimeSpec: {
        id: 'guide-only-agent',
        title: 'Guide Only Agent',
        binaryName: 'guide-only',
        docsUrl: null,
        installGuideUrl: 'https://example.test/install-guide',
        sourcePreferenceDefault: 'system-first',
        managedInstall: null,
        manualInstallKind: 'vendor_recipe',
        acceptsJavaScriptFileOverride: false,
        manualInstallRecipes: {
          linux: [{ cmd: 'bash', args: ['-lc', 'install guide-only'], requiresAdmin: false }],
        },
      },
      platform: 'linux',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.docsUrl).toBe('https://example.test/install-guide');
  });

  it('denies vendor_recipe execution by default (but still returns the plan)', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-gating-log-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const res = await installAgentCli({
        agentId: 'claude',
        platform,
        logDir,
        // Avoid accidentally running real commands in the pre-gating implementation.
        env: { ...process.env, PATH: '' },
        skipIfInstalled: false,
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.errorCode).toBe('vendor-recipe-disallowed');
      expect(res.plan?.installMode).toBe('vendor_recipe');
      expect(res.logPath).toBeNull();
      expect(res.errorMessage).toContain('allowVendorRecipeExecution');
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('fails an explicit update truthfully when the Agent has no managed updater', async () => {
    const platform = resolvePlatformFromNodePlatform(process.platform);
    expect(platform).not.toBeNull();
    if (!platform) return;

    const res = await installAgentCli({
      agentId: 'claude',
      platform,
      intent: 'update',
      dryRun: true,
      env: { ...process.env, PATH: '' },
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('update-not-available');
    expect(res.plan?.installMode).toBe('vendor_recipe');
  });

  it('uses injected spawnSync for managed_package installs (no real processes in tests)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-gating-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-gating-log-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }))
        .mockName('spawnSync');

      const res = await installAgentCli({
        agentId: 'gemini',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
          ensureManagedJavaScriptRuntimeCommand: async () => '/nonexistent/node',
          // Intentionally inject a spawnSync implementation so tests never spawn real processes.
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('managed_package');
      expect(spawnSyncMock).toHaveBeenCalled();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('installs Windows OpenCode through managed pnpm instead of system npm', async () => {
    if (!originalPlatformDescriptor || !originalArchDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    Object.defineProperty(process, 'arch', { ...originalArchDescriptor, value: 'x64' });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-opencode-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-opencode-log-'));
    try {
      const runtimeDir = join(homeDir, 'managed-runtime');
      const runtimeCommand = join(runtimeDir, 'node.exe');
      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi.fn<SpawnSyncMockFn>((_command, args, options) => {
        if (args?.includes('opencode-ai') && typeof options?.cwd === 'string') {
          const workspaceDir = options.cwd;
          const opencodePackageDir = join(workspaceDir, 'node_modules', 'opencode-ai');
          const opencodeBinDir = join(opencodePackageDir, 'bin');
          mkdirSync(opencodeBinDir, { recursive: true });
          writeFileSync(
            join(opencodePackageDir, 'package.json'),
            JSON.stringify({
              name: 'opencode-ai',
              optionalDependencies: {
                'opencode-windows-x64': '1.17.8',
                'opencode-windows-x64-baseline': '1.17.8',
              },
            }, null, 2),
            'utf8',
          );
          writeFileSync(join(opencodeBinDir, 'opencode.exe'), 'Error: opencode-ai postinstall was not run.\n', 'utf8');
          for (const packageName of ['opencode-windows-x64', 'opencode-windows-x64-baseline']) {
            const platformPackageDir = join(
              workspaceDir,
              'node_modules',
              '.pnpm',
              `${packageName}@1.17.8`,
              'node_modules',
              packageName,
            );
            const platformBinDir = join(platformPackageDir, 'bin');
            mkdirSync(platformBinDir, { recursive: true });
            writeFileSync(join(platformPackageDir, 'package.json'), JSON.stringify({ name: packageName }, null, 2), 'utf8');
            writeFileSync(join(platformBinDir, 'opencode.exe'), `REAL OPENCODE BINARY ${packageName}\n`, 'utf8');
          }
        }
        return {
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      }).mockName('spawnSync');

      const res = await installAgentCli({
        agentId: 'opencode',
        platform: 'win32',
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
          PATHEXT: '.EXE;.CMD;.BAT;.COM',
          COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => 'C:\\happier\\managed\\pnpm.cmd',
          ensureManagedJavaScriptRuntimeCommand: async () => runtimeCommand,
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('managed_package');
      expect(res.plan.managedInstall).toEqual({
        kind: 'managed_package',
        packageName: 'opencode-ai',
        binaryName: 'opencode',
        packageBinarySetup: { kind: 'opencode_platform_binary' },
      });
      const firstCall = spawnSyncMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall?.[0]).toBe('C:\\happier\\managed\\pnpm.cmd');
      expect(firstCall?.[1]).toContain('opencode-ai');
      expect(firstCall?.[1]).not.toEqual(['/c', 'npm install -g opencode-ai']);
      expect(String(firstCall?.[2]?.env?.PATH ?? '')).toContain(runtimeDir);
      const systemNpmCalls = spawnSyncMock.mock.calls.filter(([command]) => /(?:^|[\\/])npm(?:\.(?:cmd|exe))?$/i.test(command));
      expect(systemNpmCalls).toEqual([]);
      const materializedBinary = await readFile(
        join(homeDir, 'tools', 'providers', 'opencode', 'current', 'workspace', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
        'utf8',
      );
      expect(materializedBinary).toContain('REAL OPENCODE BINARY');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      Object.defineProperty(process, 'arch', originalArchDescriptor);
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('repairs the Unix OpenCode binary target when pnpm install skips postinstall', async () => {
    if (!originalPlatformDescriptor || !originalArchDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    if (process.platform === 'win32') return;

    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    Object.defineProperty(process, 'arch', { ...originalArchDescriptor, value: 'x64' });

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-opencode-unix-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-opencode-unix-log-'));
    try {
      const runtimeCommand = join(homeDir, 'managed-runtime', 'node');
      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi.fn<SpawnSyncMockFn>((_command, args, options) => {
        if (args?.includes('opencode-ai') && typeof options?.cwd === 'string') {
          const workspaceDir = options.cwd;
          const opencodePackageDir = join(workspaceDir, 'node_modules', 'opencode-ai');
          const opencodeBinDir = join(opencodePackageDir, 'bin');
          mkdirSync(opencodeBinDir, { recursive: true });
          writeFileSync(
            join(opencodePackageDir, 'package.json'),
            JSON.stringify({
              name: 'opencode-ai',
              optionalDependencies: {
                'opencode-linux-x64': '1.17.8',
                'opencode-linux-x64-baseline': '1.17.8',
              },
            }, null, 2),
            'utf8',
          );
          writeFileSync(join(opencodeBinDir, 'opencode'), 'Error: opencode-ai postinstall was not run.\n', 'utf8');
          for (const packageName of ['opencode-linux-x64', 'opencode-linux-x64-baseline']) {
            const platformPackageDir = join(
              workspaceDir,
              'node_modules',
              '.pnpm',
              `${packageName}@1.17.8`,
              'node_modules',
              packageName,
            );
            const platformBinDir = join(platformPackageDir, 'bin');
            mkdirSync(platformBinDir, { recursive: true });
            writeFileSync(join(platformPackageDir, 'package.json'), JSON.stringify({ name: packageName }, null, 2), 'utf8');
            writeFileSync(join(platformBinDir, 'opencode'), `REAL OPENCODE BINARY ${packageName}\n`, 'utf8');
          }
        }
        return {
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      }).mockName('spawnSync');

      const res = await installAgentCli({
        agentId: 'opencode',
        platform: 'linux',
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => '/happier/managed/pnpm',
          ensureManagedJavaScriptRuntimeCommand: async () => runtimeCommand,
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('managed_package');
      const materializedBinary = await readFile(
        join(homeDir, 'tools', 'providers', 'opencode', 'current', 'workspace', 'node_modules', 'opencode-ai', 'bin', 'opencode'),
        'utf8',
      );
      expect(materializedBinary).toContain('REAL OPENCODE BINARY');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      Object.defineProperty(process, 'arch', originalArchDescriptor);
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('runs managed package installs from the generated workspace and launches the installed binary from the caller cwd', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-managed-isolated-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-managed-isolated-log-'));
    const callerRepoDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-managed-caller-repo-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      await writeFile(
        join(callerRepoDir, 'package.json'),
        JSON.stringify({ private: true, packageManager: 'yarn@4.0.0' }, null, 2),
        'utf8',
      );

      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }))
        .mockName('spawnSync');

      const res = await installAgentCli({
        agentId: 'gemini',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          INIT_CWD: callerRepoDir,
          PWD: callerRepoDir,
          npm_execpath: join(callerRepoDir, '.yarn', 'releases', 'yarn.cjs'),
          npm_config_user_agent: 'yarn/4.0.0 npm/? node/?',
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
          ensureManagedJavaScriptRuntimeCommand: async () => '/nonexistent/node',
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
        },
      });

      expect(res.ok).toBe(true);
      const firstCall = spawnSyncMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const args = firstCall?.[1] ?? [];
      const workspaceDir = args[args.indexOf('--dir') + 1];
      expect(typeof workspaceDir).toBe('string');
      expect(args).toContain('--ignore-scripts');
      expect(firstCall?.[2]?.cwd).toBe(workspaceDir);
      expect(firstCall?.[2]?.env?.INIT_CWD).toBeUndefined();
      expect(firstCall?.[2]?.env?.PWD).toBe(workspaceDir);
      expect(firstCall?.[2]?.env?.npm_execpath).toBeUndefined();
      expect(firstCall?.[2]?.env?.npm_config_user_agent).toBeUndefined();

      const launcherPath = join(homeDir, 'tools', 'providers', 'gemini', 'current', 'bin', process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
      const launcher = await readFile(launcherPath, 'utf8');
      const currentWorkspaceDir = join(homeDir, 'tools', 'providers', 'gemini', 'current', 'workspace');
      const managedBinDir = join(currentWorkspaceDir, 'node_modules', '.bin');
      if (process.platform === 'win32') {
        expect(launcher).not.toContain('pushd');
        expect(launcher).not.toContain('pnpm-does-not-exist');
        expect(launcher).toContain(`"${join(managedBinDir, 'gemini.cmd')}" %*`);
      } else {
        expect(launcher).not.toContain('cd ');
        expect(launcher).not.toContain('pnpm-does-not-exist');
        expect(launcher).toContain(`exec "${join(managedBinDir, 'gemini')}" "$@"`);

        await mkdir(managedBinDir, { recursive: true });
        const recordPath = join(homeDir, 'launcher-record.json');
        await writeFile(
          join(managedBinDir, 'gemini'),
          `#!/bin/sh\n"${process.execPath}" - "$@" <<'NODE'\nconst fs = require('fs');\nfs.writeFileSync(process.env.HAPPIER_TEST_LAUNCHER_RECORD, JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD ?? null, args: process.argv.slice(2) }));\nNODE\n`,
          'utf8',
        );
        await chmod(join(managedBinDir, 'gemini'), 0o755);

        const launchResult = spawnSyncProcess(launcherPath, ['--flag', 'value'], {
          cwd: callerRepoDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            HAPPIER_TEST_LAUNCHER_RECORD: recordPath,
            PATH: process.env.PATH ?? '',
          },
        });
        expect(launchResult.status).toBe(0);
        const launchRecord = JSON.parse(await readFile(recordPath, 'utf8')) as {
          cwd: string;
          pwd: string | null;
          args: string[];
        };
        expect(await realpath(launchRecord.cwd)).toBe(await realpath(callerRepoDir));
        expect(launchRecord.pwd).not.toBe(currentWorkspaceDir);
        expect(launchRecord.args).toEqual(['--flag', 'value']);
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
      await rm(callerRepoDir, { recursive: true, force: true });
    }
  });

  it('treats a runnable system command as already installed for system-first managed agents', async () => {
    if (process.platform === 'win32') return;
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-system-home-'));
    const binDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-system-bin-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const ompPath = join(binDir, 'omp');
      await writeFile(ompPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(ompPath, 0o755);

      const res = await installAgentCli({
        agentId: 'ohMyPi',
        platform,
        dryRun: true,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: binDir,
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('github_release_binary');
      expect(res.alreadyInstalled).toBe(true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('does not treat a system-first Codex runtime as already installed for an explicit managed update', async () => {
    if (process.platform === 'win32') return;
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-update-system-home-'));
    const binDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-update-system-bin-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const codexPath = join(binDir, 'codex');
      await writeFile(codexPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(codexPath, 0o755);

      const res = await installAgentCli({
        agentId: 'codex',
        platform,
        intent: 'update',
        dryRun: true,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: binDir,
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('github_release_binary');
      expect(res.alreadyInstalled).toBe(false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('installs an absent GitHub-release managed agent through the generic release asset path', async () => {
    const expectedAssetName = expectedOhMyPiReleaseAssetName();
    if (!expectedAssetName) return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-github-binary-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-github-binary-log-'));
    const downloadCalls: Array<Readonly<{ url: string; destinationPath: string; digest?: string | null }>> = [];
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const res = await installAgentCli({
        agentId: 'ohMyPi',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          fetchGitHubLatestRelease: async () => ({
            tag_name: 'v16.1.5',
            assets: [
              {
                name: expectedAssetName,
                browser_download_url: `https://example.test/${expectedAssetName}`,
                digest: 'sha256:testdigest',
              },
            ],
          }),
          downloadGitHubReleaseAsset: async (params) => {
            downloadCalls.push({
              url: params.url,
              destinationPath: params.destinationPath,
              digest: params.digest,
            });
            await writeFile(params.destinationPath, '#!/bin/sh\nexit 0\n', 'utf8');
          },
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('github_release_binary');
      expect(res.alreadyInstalled).toBe(false);
      expect(downloadCalls).toHaveLength(1);
      expect(downloadCalls[0]?.url).toBe(`https://example.test/${expectedAssetName}`);
      expect(downloadCalls[0]?.destinationPath).toContain(expectedAssetName);
      expect(downloadCalls[0]?.digest).toBe('sha256:testdigest');
      const installedPath = join(
        homeDir,
        'tools',
        'providers',
        'ohMyPi',
        'current',
        'bin',
        process.platform === 'win32' ? 'omp.exe' : 'omp',
      );
      await expect(readFile(installedPath, 'utf8')).resolves.toBe('#!/bin/sh\nexit 0\n');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('preserves Codex archive asset selection through the generic GitHub-release path', async () => {
    // openai/codex rust-v0.147.0's digest-verified Windows x64 package contains
    // a 298,668,336-byte executable. Keep the generic archive defaults narrow,
    // but require the Codex override to admit that observed release artifact.
    const observedCodexWindowsExecutableBytes = 298_668_336;
    const expectedAssetName = expectedCodexReleaseAssetName();
    if (!expectedAssetName) return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-codex-github-binary-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-codex-github-binary-log-'));
    const downloadCalls: Array<Readonly<{ url: string; destinationPath: string; digest?: string | null }>> = [];
    const extractCalls: Array<Readonly<{
      archiveName: string;
      outputPath: string;
      outputDir?: string;
      archiveEntries?: ReadonlyArray<Readonly<{ archivePath: string; destinationPath: string }>>;
      archiveExtractionLimits?: Readonly<{
        maxFileBytes: number;
        maxExpandedBytes: number;
      }>;
    }>> = [];
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const res = await installAgentCli({
        agentId: 'codex',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          fetchGitHubLatestRelease: async () => ({
            tag_name: 'rust-v0.139.0',
            assets: [
              {
                name: expectedAssetName,
                browser_download_url: `https://example.test/${expectedAssetName}`,
                digest: 'sha256:codexdigest',
              },
            ],
          }),
          downloadGitHubReleaseAsset: async (params) => {
            downloadCalls.push({
              url: params.url,
              destinationPath: params.destinationPath,
              digest: params.digest,
            });
            await writeFile(params.destinationPath, 'archive-bytes', 'utf8');
          },
          extractGitHubReleaseAsset: async (params) => {
            extractCalls.push({
              archiveName: params.archiveName,
              outputPath: params.outputPath,
              outputDir: params.outputDir,
              archiveEntries: params.archiveEntries,
              archiveExtractionLimits: params.archiveExtractionLimits,
            });
            await materializeDeclaredArchiveEntries(params);
          },
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('github_release_binary');
      expect(downloadCalls).toHaveLength(1);
      expect(downloadCalls[0]?.url).toBe(`https://example.test/${expectedAssetName}`);
      expect(downloadCalls[0]?.destinationPath).toContain(expectedAssetName);
      expect(downloadCalls[0]?.digest).toBe('sha256:codexdigest');
      expect(extractCalls[0]?.archiveExtractionLimits?.maxFileBytes).toBeGreaterThanOrEqual(observedCodexWindowsExecutableBytes);
      expect(extractCalls).toHaveLength(1);
      const extractCall = extractCalls[0];
      expect(extractCall).toMatchObject({
        archiveName: expectedAssetName,
        archiveEntries: expectedCodexArchiveEntries(),
        archiveExtractionLimits: {
          maxFileBytes: 384 * 1024 * 1024,
          maxExpandedBytes: 384 * 1024 * 1024,
        },
      });
      expect(extractCall?.outputDir).toContain(join('tools', 'providers', 'codex', '.tmp'));
      expect(extractCall?.outputDir).toMatch(/[/\\]candidate$/);
      expect(extractCall?.outputPath).toBe(join(
        extractCall?.outputDir ?? '',
        'bin',
        process.platform === 'win32' ? 'codex.exe' : 'codex',
      ));
      const installedPath = join(
        homeDir,
        'tools',
        'providers',
        'codex',
        'current',
        'bin',
        process.platform === 'win32' ? 'codex.exe' : 'codex',
      );
      await expect(readFile(installedPath, 'utf8')).resolves.toBe('#!/bin/sh\nexit 0\n');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['system runtime with no managed install', true],
    ['current managed runtime', false],
  ] as const)('updates Codex instead of returning a successful no-op for %s', async (_caseName, useSystemRuntime) => {
    const expectedAssetName = expectedCodexReleaseAssetName();
    if (!expectedAssetName || process.platform === 'win32') return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-update-codex-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-update-codex-log-'));
    const binDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-update-codex-bin-'));
    const downloadCalls: string[] = [];
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      if (useSystemRuntime) {
        await writeFile(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(join(binDir, 'codex'), 0o755);
      } else {
        const managedCodexPath = join(homeDir, 'tools', 'providers', 'codex', 'current', 'bin', 'codex');
        await mkdir(dirname(managedCodexPath), { recursive: true });
        await writeFile(managedCodexPath, '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(managedCodexPath, 0o755);
      }

      const res = await installAgentCli({
        agentId: 'codex',
        platform,
        intent: 'update',
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: useSystemRuntime ? binDir : '',
        },
        deps: {
          fetchGitHubLatestRelease: async () => ({
            tag_name: 'rust-v0.140.0',
            assets: [{
              name: expectedAssetName,
              browser_download_url: `https://example.test/${expectedAssetName}`,
              digest: 'sha256:updated',
            }],
          }),
          downloadGitHubReleaseAsset: async (params) => {
            downloadCalls.push(params.url);
            await writeFile(params.destinationPath, 'archive-bytes', 'utf8');
          },
          extractGitHubReleaseAsset: async (params) => {
            await materializeDeclaredArchiveEntries(params);
          },
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.alreadyInstalled).toBe(false);
      expect(downloadCalls).toEqual([`https://example.test/${expectedAssetName}`]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('treats a runnable system command as already installed even when no install recipe exists', async () => {
    if (process.platform === 'win32') return;
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-system-no-recipe-home-'));
    const binDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-system-no-recipe-bin-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const cursorPath = join(binDir, 'cursor-agent');
      await writeFile(cursorPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(cursorPath, 0o755);

      const res = await installAgentCli({
        agentId: 'cursor',
        platform,
        dryRun: true,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: binDir,
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('vendor_recipe');
      expect(res.alreadyInstalled).toBe(true);
      expect(res.logPath).toBeNull();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('writes install logs with private file permissions', async () => {
    if (process.platform === 'win32') return;
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-log-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-log-dir-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }))
        .mockName('spawnSync');

      const res = await installAgentCli({
        agentId: 'gemini',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
          ensureManagedJavaScriptRuntimeCommand: async () => '/nonexistent/node',
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.logPath).not.toBeNull();
      if (!res.logPath) return;

      const fileStat = await stat(res.logPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('prepends the managed JavaScript runtime path when installing managed packages', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-runtime-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-runtime-log-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }))
        .mockName('spawnSync');

      const runtimeCommand =
        process.platform === 'win32' ? 'C:\\managed\\node\\node.exe' : '/managed/node/bin/node';

      const res = await installAgentCli({
        agentId: 'gemini',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
          ensureManagedJavaScriptRuntimeCommand: async () => runtimeCommand,
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
        },
      });

      expect(res.ok).toBe(true);
      const firstCall = spawnSyncMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const spawnEnv = firstCall?.[2]?.env;
      expect(typeof spawnEnv?.PATH).toBe('string');
      expect(String(spawnEnv?.PATH)).toContain(process.platform === 'win32' ? 'C:\\managed\\node' : '/managed/node/bin');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('surfaces a targeted memory-pressure hint when a vendor recipe is killed with exit 137', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-vendor-oom-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-vendor-oom-log-'));
    const binDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-vendor-oom-bin-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.from('installer died')],
          status: 137,
          signal: 'SIGKILL',
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('installer died'),
        }))
        .mockName('spawnSync');

      const bashPath = join(binDir, process.platform === 'win32' ? 'bash.cmd' : 'bash');
      await writeFile(bashPath, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
      if (process.platform !== 'win32') {
        await chmod(bashPath, 0o755);
      }

      const res = await installAgentCli({
        agentId: 'claude',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          HOME: homeDir,
          PATH: `${binDir}:/bin`,
        },
        skipIfInstalled: false,
        allowVendorRecipeExecution: true,
        deps: {
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
        },
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errorCode).toBe('command-failed');
      expect(res.errorMessage).toContain('ran out of memory');
      expect(res.errorMessage).toContain('increase available memory or swap');
      expect(res.logPath).not.toBeNull();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
