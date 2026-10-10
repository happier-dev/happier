import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';

import type { Capability } from '@/capabilities/service';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { withAgentCliUpdates } from './agentCliUpdates';

/** Claude's manifest update facts (packages/plugins/claude/src/manifest.ts `cli.install`). */
const claudeRuntimeSpec: AgentCliRuntimeDescriptor = {
  id: 'claude',
  title: 'Claude Code CLI',
  binaryName: 'claude',
  sourcePreferenceDefault: 'system-first',
  managedInstall: null,
  manualInstallKind: 'vendor_recipe',
  manualInstallRecipes: { linux: [{ cmd: 'bash', args: ['-lc', 'exit 0'] }], darwin: [{ cmd: 'bash', args: ['-lc', 'exit 0'] }] },
  acceptsJavaScriptFileOverride: true,
  npmPackageName: '@anthropic-ai/claude-code',
  nativeUpdate: { args: ['update'], installPaths: ['.local/share/claude', '.local/bin/claude.exe'] },
};

/**
 * Stands in for the agent detect, which spawns the installed executable to read its version (an
 * OS process boundary); the version it reports is the state the vendor updater changes.
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

describe.skipIf(process.platform === 'win32')('withAgentCliUpdates (K6)', () => {
  let root: string;
  let home: string;
  let launcher: string;
  let versioned: string;
  let versionFile: string;

  beforeEach(() => {
    root = createTempDirSync('happier-agent-cli-updates-');
    home = join(root, 'home');
    versionFile = join(root, 'installed-version');
    writeFileSync(versionFile, '2.1.0', 'utf8');
    versioned = join(home, '.local', 'share', 'claude', 'versions', '2.1.0');
    mkdirSync(join(versioned, '..'), { recursive: true });
    // The real vendor updater: `claude update` installs the next version.
    writeFileSync(versioned, `#!/bin/sh\n[ "$1" = update ] && printf 2.2.0 > '${versionFile}'\nexit 0\n`, { mode: 0o755 });
    launcher = join(home, '.local', 'bin', 'claude');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(versioned, launcher);
  });

  afterEach(() => {
    removeTempDirSync(root);
  });

  function deps(overrides: Partial<NonNullable<Parameters<typeof withAgentCliUpdates>[2]>> = {}) {
    return {
      env: { ...process.env, HOME: home, HAPPIER_HOME_DIR: join(home, '.happier'), PATH: '/usr/bin:/bin' },
      nodePlatform: 'linux',
      latestVersionTtlMs: 60_000,
      resolveRuntimeSpec: () => claudeRuntimeSpec,
      buildContext: async () => ({ cliSnapshot: null }),
      // The registry is a network boundary; tests that need a latest version supply one.
      fetchLatestVersion: async () => ({ latestVersion: null, heldVersion: null }),
      ...overrides,
    };
  }

  it('reports the install owner, its update command and a cached latest version', async () => {
    const fetchLatestVersion = vi.fn(async () => ({ latestVersion: '2.2.0', heldVersion: null }));
    const cap = withAgentCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => '2.1.0' }),
      'claude',
      deps({ fetchLatestVersion }),
    );

    await expect(cap.detect({ request: { id: 'cli.claude' }, context: { cliSnapshot: null } })).resolves.toEqual({
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

    await cap.detect({ request: { id: 'cli.claude', params: { includeLatestVersion: true, bypassCache: true } }, context: { cliSnapshot: null } });
    expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
  });

  it('preserves detected CLI facts after a 403 latest-version failure without caching it', async () => {
    const fetchLatestVersion = vi.fn(async () => {
      throw new Error('GitHub latest release lookup failed (403)');
    });
    const cap = withAgentCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => '2.1.0' }),
      'claude',
      deps({ fetchLatestVersion }),
    );
    const request = { id: 'cli.claude' as const, params: { includeLatestVersion: true } };

    await expect(cap.detect({ request, context: { cliSnapshot: null } })).resolves.toMatchObject({
      available: true, version: '2.1.0', resolvedPath: launcher, resolutionSource: 'system',
      updateSupported: true, latestVersion: null,
    });
    await cap.detect({ request, context: { cliSnapshot: null } });
    expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
  });

  it('updates through the install owner after confirmation and succeeds only on a changed re-read version', async () => {
    const cap = withAgentCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => readFileSync(versionFile, 'utf8') }),
      'claude',
      deps(),
    );

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'install-confirmation-required' } });
    expect(readFileSync(versionFile, 'utf8')).toBe('2.1.0');

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } })).resolves.toMatchObject({
      ok: true,
      result: { previousVersion: '2.1.0', version: '2.2.0', installSource: 'native' },
    });
  });

  it('does not count a clean exit as success when the version did not change', async () => {
    writeFileSync(versioned, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const cap = withAgentCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => '2.1.0' }),
      'claude',
      deps(),
    );

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'update-not-verified' } });
  });

  it('refuses a package-manager install by name with its own command', async () => {
    const packageDir = join(root, 'prefix', 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'cli.js'), '#!/bin/sh\n', { mode: 0o755 });
    const npmLauncher = join(root, 'prefix', 'bin', 'claude');
    mkdirSync(join(npmLauncher, '..'), { recursive: true });
    symlinkSync(join(packageDir, 'cli.js'), npmLauncher);
    const cap = withAgentCliUpdates(
      createInstalledCliCapability({ resolvedPath: npmLauncher, version: () => '2.1.0' }),
      'claude',
      deps(),
    );

    await expect(cap.detect({ request: { id: 'cli.claude' }, context: { cliSnapshot: null } })).resolves.toMatchObject({
      installSource: 'npm',
      updateSupported: false,
      updateCommand: 'npm install -g @anthropic-ai/claude-code@latest',
    });
    const refused = await cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } });
    expect(refused).toMatchObject({ ok: false, error: { code: 'update-not-available' } });
    if (!refused.ok) expect(refused.error.message).toContain('npm install -g @anthropic-ai/claude-code@latest');
  });

  it('keeps answering other capability requests while a slow vendor updater runs', async () => {
    const startedMarker = join(root, 'update-started');
    writeFileSync(
      versioned,
      `#!/bin/sh\ntouch '${startedMarker}'\nsleep 2\nprintf 2.2.0 > '${versionFile}'\n`,
      { mode: 0o755 },
    );
    const cap = withAgentCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => readFileSync(versionFile, 'utf8') }),
      'claude',
      deps(),
    );

    const updating = cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } });
    const startedAt = Date.now();
    while (!existsSync(startedMarker) && Date.now() - startedAt < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(startedMarker)).toBe(true);

    await expect(cap.detect({ request: { id: 'cli.claude' }, context: { cliSnapshot: null } })).resolves.toMatchObject({ version: '2.1.0' });
    await expect(updating).resolves.toMatchObject({ ok: true, result: { previousVersion: '2.1.0', version: '2.2.0' } });
  }, 30_000);

  it('treats an unchanged version that is already the latest as up to date', async () => {
    // Observed 2026-09-26: a retried `claude update` printed "Claude Code is up to date (2.1.283)".
    writeFileSync(versioned, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const cap = withAgentCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => readFileSync(versionFile, 'utf8') }),
      'claude',
      deps({ fetchLatestVersion: async () => ({ latestVersion: '2.1.0', heldVersion: null }) }),
    );

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } }))
      .resolves.toMatchObject({
        ok: true,
        result: { previousVersion: '2.1.0', version: '2.1.0', latestVersion: '2.1.0', alreadyCurrent: true },
      });
  });

  it('names a release-age hold instead of reporting the unchanged version as unverified', async () => {
    writeFileSync(versioned, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const cap = withAgentCliUpdates(
      createInstalledCliCapability({ resolvedPath: launcher, version: () => readFileSync(versionFile, 'utf8') }),
      'claude',
      deps({
        fetchLatestVersion: async () => ({
          latestVersion: '2.1.0',
          heldVersion: { version: '2.1.1', minimumReleaseAgeMs: 24 * 60 * 60_000 },
        }),
      }),
    );

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'update-held-by-release-age', message: "2.1.1 is less than a day old; Happier installs it once it's a day old." },
      });
  });
});
