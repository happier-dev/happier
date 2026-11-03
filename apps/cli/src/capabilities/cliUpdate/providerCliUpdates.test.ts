import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { runCommandCapture } from '@happier-dev/cli-common/process';
import { fetchProviderCliLatestVersion, installProviderCli } from '@happier-dev/cli-common/providers';

import type { Capability } from '@/capabilities/service';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { withProviderCliUpdates } from './providerCliUpdates';

function writeExecutable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  return path;
}

type RunCommand = typeof runCommandCapture;

function succeeded(): Awaited<ReturnType<RunCommand>> {
  return { kind: 'exited', status: 0, signal: null, stdout: '', stderr: '' };
}

/**
 * Stands in for the provider detect, which spawns the installed executable to
 * read its version (an OS process boundary); the version it reports is the
 * state the vendor updater changes.
 */
function createInstalledCliCapability(params: { resolvedPath: string; version: () => string }): Capability {
  return {
    descriptor: { id: 'cli.claude', kind: 'cli', title: 'Claude CLI', methods: { install: { title: 'Install' } } },
    detect: async () => ({
      available: true,
      resolvedPath: params.resolvedPath,
      resolutionSource: 'system',
      version: params.version(),
    }),
    invoke: async () => ({ ok: false, error: { message: 'unexpected', code: 'unexpected' } }),
  };
}

describe.skipIf(process.platform === 'win32')('withProviderCliUpdates', () => {
  let root: string;
  let home: string;
  let launcher: string;

  beforeEach(() => {
    root = createTempDirSync('happier-provider-cli-updates-');
    home = join(root, 'home');
    const versioned = writeExecutable(join(home, '.local', 'share', 'claude', 'versions', '2.1.0'));
    launcher = join(home, '.local', 'bin', 'claude');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(versioned, launcher);
  });

  afterEach(() => {
    removeTempDirSync(root);
  });

  function deps(overrides: Partial<Parameters<typeof withProviderCliUpdates>[2]> = {}) {
    return {
      env: { HOME: home, HAPPIER_HOME_DIR: home, PATH: '' },
      nodePlatform: 'linux',
      latestVersionTtlMs: 60_000,
      buildContext: async () => ({ cliSnapshot: null }),
      // The registry is a network boundary; tests that need a latest version supply one.
      fetchLatestVersion: async () => ({ latestVersion: null, heldVersion: null }),
      ...overrides,
    };
  }

  it('reports the install owner, its update command and a cached latest version', async () => {
    const fetchLatestVersion = vi.fn(async () => ({ latestVersion: '2.2.0', heldVersion: null }));
    const cap = withProviderCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => '2.1.0' }),
      'claude',
      deps({ fetchLatestVersion }),
    );

    const plain = await cap.detect({ request: { id: 'cli.claude' }, context: { cliSnapshot: null } });
    expect(plain).toEqual({
      available: true,
      resolvedPath: launcher,
      resolutionSource: 'system',
      version: '2.1.0',
      installSource: 'native',
      updateSupported: true,
      updateCommand: `${launcher} update`,
    });
    expect(fetchLatestVersion).not.toHaveBeenCalled();

    const request = { id: 'cli.claude' as const, params: { includeLatestVersion: true } };
    await expect(cap.detect({ request, context: { cliSnapshot: null } })).resolves.toMatchObject({ latestVersion: '2.2.0' });
    await cap.detect({ request, context: { cliSnapshot: null } });
    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);

    await cap.detect({
      request: { id: 'cli.claude', params: { includeLatestVersion: true, bypassCache: true } },
      context: { cliSnapshot: null },
    });
    expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown latest version without caching the failure', async () => {
    const fetchLatestVersion = vi.fn(async () => {
      throw new Error('registry unavailable');
    });
    const cap = withProviderCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => '2.1.0' }),
      'claude',
      deps({ fetchLatestVersion }),
    );
    const request = { id: 'cli.claude' as const, params: { includeLatestVersion: true } };

    await expect(cap.detect({ request, context: { cliSnapshot: null } })).resolves.toMatchObject({ latestVersion: null });
    await cap.detect({ request, context: { cliSnapshot: null } });
    expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
  });

  it('keeps latest versions consistent with the installed package when switching OpenCode generations', async () => {
    let packageName = 'opencode-ai';
    const legacy = writeExecutable(join(root, 'prefix/lib/node_modules/opencode-ai/bin/opencode.exe'));
    const current = writeExecutable(join(root, 'prefix/lib/node_modules/@opencode/cli/bin/opencode.exe'));
    const cap = withProviderCliUpdates({
      descriptor: { id: 'cli.opencode', kind: 'cli', title: 'OpenCode CLI' },
      // Detect's executable/version probe is an OS boundary; attribution and cache stay real.
      detect: async () => ({ available: true, resolvedPath: packageName === 'opencode-ai' ? legacy : current,
        resolutionSource: 'system', version: packageName === 'opencode-ai' ? '1.19.5' : '2.2.5' }),
    }, 'opencode', deps({
      fetchLatestVersion: async (providerId, installSource, npmPackageName?: string) => fetchProviderCliLatestVersion({
        providerId, installSource, ...{ npmPackageName },
        deps: { fetchJson: async (url) => ({ version: url.includes('opencode-ai') ? '1.19.5' : '2.2.5' }) },
      }),
    }));
    const args = { request: { id: 'cli.opencode' as const, params: { includeLatestVersion: true } }, context: { cliSnapshot: null } };
    await expect(cap.detect(args)).resolves.toMatchObject({ latestVersion: '1.19.5', updateCommand: 'npm install -g opencode-ai@latest' });
    packageName = '@opencode/cli';
    await expect(cap.detect(args)).resolves.toMatchObject({ latestVersion: '2.2.5', updateCommand: 'npm install -g @opencode/cli@latest' });
    packageName = 'opencode-ai';
    await expect(cap.detect(args)).resolves.toMatchObject({ latestVersion: '1.19.5' });
  });

  it('updates through the install owner and succeeds only when the re-read version changed', async () => {
    let installedVersion = '2.1.0';
    const runCommand = vi.fn<RunCommand>(async () => {
      installedVersion = '2.2.0';
      return succeeded();
    });
    const cap = withProviderCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => installedVersion }),
      'claude',
      deps({
        installProviderCli: (params) => installProviderCli({
          ...params,
          logDir: join(root, 'logs'),
          deps: { runCommand },
        }),
      }),
    );

    const unconfirmed = await cap.invoke!({ method: 'install', params: { intent: 'update' } });
    expect(unconfirmed).toMatchObject({ ok: false, error: { code: 'install-confirmation-required' } });
    expect(runCommand).not.toHaveBeenCalled();

    const updated = await cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } });
    expect(updated).toMatchObject({
      ok: true,
      result: { previousVersion: '2.1.0', version: '2.2.0', installSource: 'native' },
    });
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: launcher, args: ['update'] }));
  });

  it('does not count a clean exit as success when the version did not change', async () => {
    const cap = withProviderCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => '2.1.0' }),
      'claude',
      deps({
        installProviderCli: (params) => installProviderCli({
          ...params,
          logDir: join(root, 'logs'),
          deps: { runCommand: async () => succeeded() },
        }),
      }),
    );

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'update-not-verified' } });
  });

  it('keeps answering other capability requests while a slow vendor updater runs', async () => {
    const startedMarker = join(root, 'update-started');
    const versionFile = join(root, 'installed-version');
    writeFileSync(versionFile, '2.1.0', 'utf8');
    // The real vendor updater process (no spawn injection): it signals that it started,
    // stays busy like a download, then installs the new version.
    writeFileSync(
      join(home, '.local', 'share', 'claude', 'versions', '2.1.0'),
      `#!/bin/sh\ntouch '${startedMarker}'\nsleep 2\nprintf 2.2.0 > '${versionFile}'\n`,
      { mode: 0o755 },
    );
    const cap = withProviderCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => readFileSync(versionFile, 'utf8') }),
      'claude',
      deps({
        env: { ...process.env, HOME: home, HAPPIER_HOME_DIR: home },
        installProviderCli: (params) => installProviderCli({ ...params, logDir: join(root, 'logs') }),
      }),
    );

    const updating = cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } });
    const startedAt = Date.now();
    while (!existsSync(startedMarker) && Date.now() - startedAt < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(startedMarker)).toBe(true);

    const concurrent = await cap.detect({ request: { id: 'cli.claude' }, context: { cliSnapshot: null } });
    expect(concurrent).toMatchObject({ version: '2.1.0' });

    await expect(updating).resolves.toMatchObject({
      ok: true,
      result: { previousVersion: '2.1.0', version: '2.2.0' },
    });
  }, 30_000);

  it('names the release-age hold instead of reporting an unchanged managed update as unverified', async () => {
    const managedCommand = join(home, 'tools', 'providers', 'qwen', 'current', 'bin', 'qwen');
    const cap = withProviderCliUpdates(
      {
        descriptor: { id: 'cli.qwen', kind: 'cli', title: 'Qwen CLI' },
        detect: async () => ({ available: true, resolvedPath: managedCommand, resolutionSource: 'managed', version: '0.24.5' }),
      },
      'qwen',
      deps({
        installProviderCli: async () => ({
          ok: true,
          alreadyInstalled: false,
          logPath: null,
          plan: {
            providerId: 'qwen', title: 'Qwen CLI', binaries: ['qwen'], platform: 'linux', docsUrl: null, commands: [],
            requiresAdmin: false, installMode: 'managed_package',
            managedInstall: { kind: 'managed_package', packageName: '@qwen-code/qwen-code', binaryName: 'qwen' },
          },
        }),
        fetchLatestVersion: async () => ({
          latestVersion: '0.24.5',
          heldVersion: { version: '0.24.6', minimumReleaseAgeMs: 24 * 60 * 60_000 },
        }),
      }),
    );

    await expect(cap.detect({ request: { id: 'cli.qwen', params: { includeLatestVersion: true } }, context: { cliSnapshot: null } }))
      .resolves.toMatchObject({ installSource: 'managed', latestVersion: '0.24.5' });
    await expect(cap.invoke!({ method: 'install', params: { intent: 'update' } })).resolves.toEqual({
      ok: false,
      error: {
        code: 'update-held-by-release-age',
        message: "0.24.6 is less than a day old; Happier installs it once it's a day old.",
      },
    });
  });

  it('treats an unchanged version that is already the latest as up to date', async () => {
    // Observed 2026-09-26: a retried `claude update` printed "Claude Code is up to date (2.1.283)".
    const cap = withProviderCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => '2.1.283' }),
      'claude',
      deps({
        installProviderCli: (params) => installProviderCli({
          ...params,
          logDir: join(root, 'logs'),
          deps: { runCommand: async () => succeeded() },
        }),
        fetchLatestVersion: async () => ({ latestVersion: '2.1.283', heldVersion: null }),
      }),
    );

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } }))
      .resolves.toMatchObject({
        ok: true,
        result: { previousVersion: '2.1.283', version: '2.1.283', latestVersion: '2.1.283', alreadyCurrent: true },
      });
  });
});
