import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { describe, expect, it, vi } from 'vitest';

import { resolvePlatformFromNodePlatform } from './install.js';
import { prepareAgentCliForRuntime } from './prepareForRuntime.js';
import { getHappierTempRoot } from '../tempDirs/index.js';

function expectedOhMyPiReleaseAssetName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'omp-darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'omp-darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'omp-linux-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'omp-linux-x64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'omp-windows-x64.exe';
  return null;
}

function ohMyPiRuntimeSpec() {
  const runtimeSpec = getAgentCliRuntimeSpec('ohMyPi');
  if (!runtimeSpec) throw new Error('Expected a bundled ohMyPi CLI runtime spec');
  return runtimeSpec;
}

function managedOhMyPiCommandPath(homeDir: string): string {
  return join(
    homeDir,
    'tools',
    'providers',
    'ohMyPi',
    'current',
    'bin',
    process.platform === 'win32' ? 'omp.exe' : 'omp',
  );
}

describe('prepareAgentCliForRuntime managed_only', () => {
  it.skipIf(process.platform === 'win32')('aborts an in-flight managed package acquisition without publishing an executable', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-managed-abort-'));
    const marker = join(homeDir, 'install-started');
    const pnpm = join(homeDir, 'managed-pnpm');
    const controller = new AbortController();
    try {
      // A real process boundary makes event-loop blocking and cancellation observable.
      await writeFile(pnpm, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setTimeout(() => {}, 1500);\n`);
      await chmod(pnpm, 0o755);
      const runtimeSpec = getAgentCliRuntimeSpec('gemini');
      if (!runtimeSpec) throw new Error('Expected gemini managed install');
      const pending = prepareAgentCliForRuntime({
        runtimeSpec,
        platform: process.platform === 'darwin' ? 'darwin' : 'linux',
        sourcePolicy: 'managed_only',
        signal: controller.signal,
        env: { ...process.env, HAPPIER_HOME_DIR: homeDir, HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath },
      }).then(value => ({ value }), error => ({ error }));
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      controller.abort();
      const outcome = await pending;
      expect(outcome).toHaveProperty('error.name', 'AbortError');
      expect(existsSync(join(homeDir, 'tools', 'providers', 'gemini', 'current'))).toBe(false);
      expect(await readdir(getHappierTempRoot(join(homeDir, 'tools', 'providers', 'gemini', '.tmp')))).toEqual([]);
      const pid = Number(await readFile(marker, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('ignores an override and a system install and prepares the activation-local managed executable', async () => {
    const expectedAssetName = expectedOhMyPiReleaseAssetName();
    if (!expectedAssetName) return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-prepare-managed-home-'));
    const foreignBinDir = await mkdtemp(join(tmpdir(), 'happier-prepare-managed-foreign-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-prepare-managed-log-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const foreignPath = join(foreignBinDir, process.platform === 'win32' ? 'omp.exe' : 'omp');
      await writeFile(foreignPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(foreignPath, 0o755);

      const downloadCalls: string[] = [];
      const prepared = await prepareAgentCliForRuntime({
        runtimeSpec: ohMyPiRuntimeSpec(),
        platform,
        sourcePolicy: 'managed_only',
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: foreignBinDir,
          HAPPIER_OHMYPI_PATH: foreignPath,
        },
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
            downloadCalls.push(params.url);
            await writeFile(params.destinationPath, '#!/bin/sh\nexit 0\n', 'utf8');
          },
        },
      });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.resolution).toEqual({
        source: 'managed',
        command: managedOhMyPiCommandPath(homeDir),
      });
      expect(prepared.resolution.command).not.toBe(foreignPath);
      expect(prepared.alreadyInstalled).toBe(false);
      expect(downloadCalls).toHaveLength(1);
      await expect(readFile(prepared.resolution.command, 'utf8')).resolves.toBe('#!/bin/sh\nexit 0\n');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(foreignBinDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('reuses the current activation-local managed install on retry without installing again', async () => {
    const expectedAssetName = expectedOhMyPiReleaseAssetName();
    if (!expectedAssetName) return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-prepare-managed-retry-home-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const downloadCalls: string[] = [];
      const deps = {
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
        downloadGitHubReleaseAsset: async (params: Readonly<{ url: string; destinationPath: string }>) => {
          downloadCalls.push(params.url);
          await writeFile(params.destinationPath, '#!/bin/sh\nexit 0\n', 'utf8');
        },
      };
      const env = { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' };

      const first = await prepareAgentCliForRuntime({
        runtimeSpec: ohMyPiRuntimeSpec(),
        platform,
        sourcePolicy: 'managed_only',
        env,
        deps,
      });
      const second = await prepareAgentCliForRuntime({
        runtimeSpec: ohMyPiRuntimeSpec(),
        platform,
        sourcePolicy: 'managed_only',
        env,
        deps,
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.alreadyInstalled).toBe(false);
      expect(second.alreadyInstalled).toBe(true);
      expect(second.resolution).toEqual(first.resolution);
      expect(downloadCalls).toHaveLength(1);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('returns no resolution when the managed install fails', async () => {
    const expectedAssetName = expectedOhMyPiReleaseAssetName();
    if (!expectedAssetName) return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-prepare-managed-failure-home-'));
    const foreignBinDir = await mkdtemp(join(tmpdir(), 'happier-prepare-managed-failure-bin-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const foreignPath = join(foreignBinDir, process.platform === 'win32' ? 'omp.exe' : 'omp');
      await writeFile(foreignPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(foreignPath, 0o755);

      const prepared = await prepareAgentCliForRuntime({
        runtimeSpec: ohMyPiRuntimeSpec(),
        platform,
        sourcePolicy: 'managed_only',
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: foreignBinDir,
          HAPPIER_OHMYPI_PATH: foreignPath,
        },
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
          downloadGitHubReleaseAsset: async () => {
            throw new Error('release asset download refused');
          },
        },
      });

      expect(prepared.ok).toBe(false);
      if (prepared.ok) return;
      expect(prepared).not.toHaveProperty('resolution');
      expect(prepared.errorMessage).toContain('release asset download refused');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(foreignBinDir, { recursive: true, force: true });
    }
  });

  it('refuses an Agent whose canonical declaration has no managed install', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'happier-prepare-vendor-bin-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const vendorRecipeSpawn = vi.fn();
      const claudePath = join(binDir, process.platform === 'win32' ? 'claude.exe' : 'claude');
      await writeFile(claudePath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(claudePath, 0o755);

      const prepared = await prepareAgentCliForRuntime({
        runtimeSpec: {
          id: 'claude',
          title: 'Claude Code',
          binaryName: 'claude',
          sourcePreferenceDefault: 'system-first',
          managedInstall: null,
          manualInstallKind: 'vendor_recipe',
          manualInstallRecipes: {
            darwin: [{ cmd: 'sh', args: ['-c', 'exit 0'] }],
            linux: [{ cmd: 'sh', args: ['-c', 'exit 0'] }],
            win32: [{ cmd: 'sh', args: ['-c', 'exit 0'] }],
          },
          acceptsJavaScriptFileOverride: false,
        },
        platform,
        sourcePolicy: 'managed_only',
        env: { ...process.env, PATH: binDir },
        deps: { execFileWithDeadline: vendorRecipeSpawn as unknown as NonNullable<NonNullable<Parameters<typeof prepareAgentCliForRuntime>[0]['deps']>['execFileWithDeadline']> },
      });

      expect(prepared.ok).toBe(false);
      if (prepared.ok) return;
      expect(prepared.errorCode).toBe('managed-install-unsupported');
      expect(vendorRecipeSpawn).not.toHaveBeenCalled();
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('prepares a managed package Agent through its installed launcher', async () => {
    if (process.platform === 'win32') return;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-prepare-managed-package-home-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const runtimeSpec = getAgentCliRuntimeSpec('gemini');
      if (!runtimeSpec) throw new Error('Expected a bundled gemini CLI runtime spec');
      expect(runtimeSpec.managedInstall?.kind).toBe('managed_package');

      const spawnSyncMock = vi.fn(() => ({
        pid: 0,
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }));

      const prepared = await prepareAgentCliForRuntime({
        runtimeSpec,
        platform,
        sourcePolicy: 'managed_only',
        env: { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' },
        deps: {
          ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
          ensureManagedJavaScriptRuntimeCommand: async () => '/nonexistent/node',
          execFileWithDeadline: async () => spawnSyncMock(),
        },
      });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.resolution).toEqual({
        source: 'managed',
        command: join(homeDir, 'tools', 'providers', 'gemini', 'current', 'bin', 'gemini'),
      });
      const launcher = await readFile(prepared.resolution.command, 'utf8');
      expect(launcher).not.toContain('pnpm-does-not-exist');
      expect(launcher).toContain(
        join(homeDir, 'tools', 'providers', 'gemini', 'current', 'workspace', 'node_modules', '.bin', 'gemini'),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
