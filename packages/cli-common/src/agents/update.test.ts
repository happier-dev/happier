import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCliInstallPlatform } from '@happier-dev/agents/cli/runtime';
import type { AgentCliRuntimeDescriptor } from './resolution.js';
import { classifyAgentCliInstall, fetchAgentCliLatestVersion } from './update.js';

function runtimeSpec(overrides: Partial<AgentCliRuntimeDescriptor> = {}): AgentCliRuntimeDescriptor {
  return {
    id: 'claude',
    title: 'Claude Code CLI',
    binaryName: 'claude',
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    npmPackageName: '@anthropic-ai/claude-code',
    nativeUpdate: { args: ['update'], installPaths: ['.local/share/claude'] },
    ...overrides,
  };
}

const platform: AgentCliInstallPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

it.each(['npm', 'github'] as const)('latest-version lookup cancels its real %s response transport', async (source) => {
  const controller = new AbortController();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    controller.abort();
    const timer = setTimeout(() => response.end('}'), 100);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const fetchImpl: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init);
    const spec = source === 'npm' ? runtimeSpec() : runtimeSpec({ managedInstall: {
      kind: 'github_release_binary', githubRepo: 'fixture/fixture', binaryName: 'fixture',
    } });
    await expect(fetchAgentCliLatestVersion({
      runtimeSpec: spec, installSource: 'native', signal: controller.signal,
      deps: { fetchImpl, fetchGitHubLatestRelease: (params) => fetchGitHubLatestRelease({ ...params, fetchImpl }) },
    })).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('classifyAgentCliInstall', () => {
  it('keeps a shared member managed install readable without offering an update', () => {
    const params = { runtimeSpec: runtimeSpec({ managedInstall: {
      kind: 'github_release_binary', githubRepo: 'fixture/fixture', binaryName: 'fixture',
    } }), command: '/shared/tools/fixture', source: 'managed' as const, platform };
    expect(classifyAgentCliInstall({ ...params, readOnly: true })).toMatchObject({
      installSource: 'managed', updateSupported: false, updateCommand: null,
    });
    expect(classifyAgentCliInstall(params)).toMatchObject({
      installSource: 'managed', updateSupported: true,
    });
  });

  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'happier-agent-cli-update-')));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('attributes a vendor-installed CLI linked into its install root to the declared native updater', async () => {
    const versionsDir = join(home, '.local', 'share', 'claude', 'versions');
    await mkdir(versionsDir, { recursive: true });
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await writeFile(join(versionsDir, '2.1.0'), '#!/bin/sh\n', 'utf8');
    const command = join(home, '.local', 'bin', 'claude');
    await symlink(join(versionsDir, '2.1.0'), command);

    expect(classifyAgentCliInstall({ runtimeSpec: runtimeSpec(), command, source: 'system', platform, env: { HOME: home } })).toEqual({
      installSource: 'native',
      updateSupported: true,
      updateCommand: `${command} update`,
      nativeUpdateArgs: ['update'],
    });
  });

  it.skipIf(process.platform === 'win32')('attributes an npm global install by its real path and never offers the vendor updater for it', async () => {
    const packageDir = join(home, 'prefix', 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(home, 'prefix', 'bin'), { recursive: true });
    await writeFile(join(packageDir, 'cli.js'), '', 'utf8');
    const command = join(home, 'prefix', 'bin', 'claude');
    await symlink(join(packageDir, 'cli.js'), command);

    expect(classifyAgentCliInstall({ runtimeSpec: runtimeSpec(), command, source: 'system', platform, env: { HOME: home } })).toEqual({
      installSource: 'npm',
      updateSupported: false,
      updateCommand: 'npm install -g @anthropic-ai/claude-code@latest',
      nativeUpdateArgs: null,
      npmPackageName: '@anthropic-ai/claude-code',
    });
  });

  it.skipIf(process.platform === 'win32')('attributes a Homebrew cask and the managed package name of a managed-package agent', async () => {
    const caskBin = join(home, 'Caskroom', 'claude-code', '2.1.0');
    await mkdir(caskBin, { recursive: true });
    await writeFile(join(caskBin, 'claude'), '', 'utf8');
    const command = join(home, 'bin-claude');
    await symlink(join(caskBin, 'claude'), command);
    expect(classifyAgentCliInstall({ runtimeSpec: runtimeSpec(), command, source: 'system', platform, env: { HOME: home } }).updateCommand)
      .toBe('brew upgrade --cask claude-code');

    const pnpmPackage = join(home, 'pnpm', 'global', '5', 'node_modules', 'opencode-ai');
    await mkdir(pnpmPackage, { recursive: true });
    await writeFile(join(pnpmPackage, 'bin.js'), '', 'utf8');
    const opencode = join(home, 'opencode');
    await symlink(join(pnpmPackage, 'bin.js'), opencode);
    expect(classifyAgentCliInstall({
      runtimeSpec: runtimeSpec({
        id: 'opencode',
        npmPackageName: undefined,
        nativeUpdate: null,
        managedInstall: { kind: 'managed_package', packageName: 'opencode-ai', binaryName: 'opencode' },
      }),
      command: opencode,
      source: 'system',
      platform,
      env: { HOME: home },
    })).toMatchObject({ installSource: 'pnpm', updateSupported: false, updateCommand: 'pnpm add -g opencode-ai@latest' });
  });

  it.each([
    ['npm', '@opencode/cli', 'prefix/lib', 'npm install -g @opencode/cli@latest'],
    ['pnpm', '@opencode/cli', 'pnpm/global/5', 'pnpm add -g --allow-build=@opencode/cli @opencode/cli@latest'],
    ['bun', '@opencode/cli', '.bun/install/global', 'bun add -g --trust @opencode/cli@latest'],
    ['pnpm', 'opencode-ai', 'pnpm/global/5', 'pnpm add -g opencode-ai@latest'],
  ] as const)('attributes %s package %s before generic manager hints', async (manager, packageName, prefix, updateCommand) => {
    const command = join(home, prefix, 'node_modules', packageName, 'bin', 'opencode.exe');
    await mkdir(join(command, '..'), { recursive: true });
    await writeFile(command, '', 'utf8');
    expect(classifyAgentCliInstall({
      runtimeSpec: runtimeSpec({ id: 'opencode', nativeUpdate: null, npmPackageName: 'opencode-ai',
        managedInstall: { kind: 'managed_package', packageName: '@opencode/cli', binaryName: 'opencode', allowBuild: true } }),
      command, source: 'system', platform,
      env: { HOME: home, ...(manager === 'pnpm' ? { PNPM_HOME: join(command, '..') } : {}) },
    })).toMatchObject({ installSource: manager, updateSupported: false, updateCommand, npmPackageName: packageName });
  });

  it.each(['@opencode/cli', 'opencode-ai'])('attributes a Windows shim beside %s', async (packageName) => {
    const prefix = join(home, 'npm');
    const packageDir = join(prefix, 'node_modules', packageName);
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: packageName }), 'utf8');
    expect(classifyAgentCliInstall({
      runtimeSpec: runtimeSpec({ id: 'opencode', nativeUpdate: null, npmPackageName: 'opencode-ai',
        managedInstall: { kind: 'managed_package', packageName: '@opencode/cli', binaryName: 'opencode' } }),
      command: join(prefix, 'opencode.cmd'), source: 'system', platform: 'win32', env: { USERPROFILE: home },
    })).toMatchObject({ installSource: 'npm', updateCommand: `npm install -g ${packageName}@latest`, npmPackageName: packageName });
  });

  it('keeps managed installs Happier-updatable and never attributes an override', () => {
    const managed = runtimeSpec({ managedInstall: { kind: 'managed_package', packageName: 'x', binaryName: 'claude' } });
    expect(classifyAgentCliInstall({ runtimeSpec: managed, command: '/m/claude', source: 'managed', platform })).toMatchObject({
      installSource: 'managed',
      updateSupported: true,
      updateCommand: null,
    });
    expect(classifyAgentCliInstall({ runtimeSpec: runtimeSpec(), command: join(home, '.local', 'share', 'claude', 'c'), source: 'override', platform, env: { HOME: home } }))
      .toEqual({ installSource: 'other', updateSupported: false, updateCommand: null, nativeUpdateArgs: null });
  });
});

describe('fetchAgentCliLatestVersion', () => {
  const DAY_MS = 24 * 60 * 60_000;
  const now = Date.parse('2026-09-26T08:00:00Z');
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  it('reads npm latest for the vendor package over HTTP with a scoped-name URL', async () => {
    const fetchImpl = vi.fn(async () => json({ version: '2.2.0' }));
    await expect(fetchAgentCliLatestVersion({ runtimeSpec: runtimeSpec(), installSource: 'native', deps: { fetchImpl } }))
      .resolves.toEqual({ latestVersion: '2.2.0', heldVersion: null });
    expect(fetchImpl).toHaveBeenCalledWith('https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest', expect.anything());
  });

  it('retains proven external package identity while managed installs use the current package', async () => {
    const spec = runtimeSpec({ id: 'opencode', nativeUpdate: null, npmPackageName: 'opencode-ai',
      managedInstall: { kind: 'managed_package', packageName: '@opencode/cli', binaryName: 'opencode' } });
    const fetchImpl: typeof fetch = async (url) => json({ version: String(url).includes('opencode-ai') ? '1.19.5' : '2.2.5' });
    await expect(fetchAgentCliLatestVersion({ runtimeSpec: spec, installSource: 'npm', npmPackageName: 'opencode-ai', deps: { fetchImpl } }))
      .resolves.toEqual({ latestVersion: '1.19.5', heldVersion: null });
    await expect(fetchAgentCliLatestVersion({ runtimeSpec: spec, installSource: 'managed', npmPackageName: 'opencode-ai',
      deps: { fetchImpl, readMinimumReleaseAgeMs: async () => null } }))
      .resolves.toEqual({ latestVersion: '2.2.5', heldVersion: null });
  });

  it('reads the managed GitHub release tag for a release-binary agent', async () => {
    const fetchGitHubLatestRelease = vi.fn(async () => ({ tag_name: 'rust-v0.157.0' }));
    await expect(fetchAgentCliLatestVersion({
      runtimeSpec: runtimeSpec({ managedInstall: { kind: 'github_release_binary', githubRepo: 'openai/codex', binaryName: 'codex' } }),
      installSource: 'managed',
      deps: { fetchGitHubLatestRelease },
    })).resolves.toEqual({ latestVersion: '0.157.0', heldVersion: null });
  });

  it.each(['native', 'npm'] as const)('preserves vendor latest for a %s install when the managed installer is pinned', async (installSource) => {
    const fetchImpl: typeof fetch = async (url) => json({
      tag_name: String(url).endsWith('/tags/qualified-v1.2.3') ? 'qualified-v1.2.3' : 'v1.2.4',
    });
    await expect(fetchAgentCliLatestVersion({
      runtimeSpec: runtimeSpec({ managedInstall: {
        kind: 'github_release_binary', githubRepo: 'acme/fixture', binaryName: 'fixture',
        releaseTag: 'qualified-v1.2.3',
      } }),
      installSource,
      deps: {
        fetchGitHubLatestRelease: (params) => fetchGitHubLatestRelease({ ...params, fetchImpl }),
      },
    })).resolves.toEqual({ latestVersion: '1.2.4', heldVersion: null });
  });

  it('offers a managed package only once the managed installer will take it', async () => {
    const managed = runtimeSpec({
      npmPackageName: null,
      managedInstall: { kind: 'managed_package', packageName: '@qwen-code/qwen-code', binaryName: 'qwen' },
    });
    const packument = {
      'dist-tags': { latest: '0.24.6' },
      time: {
        '0.24.4': new Date(now - 9 * DAY_MS).toISOString(),
        '0.24.5': new Date(now - 3 * DAY_MS).toISOString(),
        '0.25.0-preview.1': new Date(now - 2 * DAY_MS).toISOString(),
        '0.24.6': new Date(now - 7 * 60 * 60_000).toISOString(),
      },
    };
    const fetchImpl = vi.fn(async () => json(packument));
    const readMinimumReleaseAgeMs = vi.fn(async () => DAY_MS);

    await expect(fetchAgentCliLatestVersion({
      runtimeSpec: managed,
      installSource: 'managed',
      now: () => now,
      deps: { fetchImpl, readMinimumReleaseAgeMs },
    })).resolves.toEqual({ latestVersion: '0.24.5', heldVersion: { version: '0.24.6', minimumReleaseAgeMs: DAY_MS } });
    expect(fetchImpl).toHaveBeenCalledWith('https://registry.npmjs.org/@qwen-code%2Fqwen-code', expect.anything());

    const npmFetch = vi.fn(async () => json({ version: '0.24.6' }));
    await expect(fetchAgentCliLatestVersion({
      runtimeSpec: managed,
      installSource: 'npm',
      deps: { fetchImpl: npmFetch, readMinimumReleaseAgeMs },
    })).resolves.toEqual({ latestVersion: '0.24.6', heldVersion: null });
  });

  it('is empty without a declared source and rejects a registry failure so callers do not cache it', async () => {
    await expect(fetchAgentCliLatestVersion({ runtimeSpec: runtimeSpec({ npmPackageName: null }), installSource: 'other' }))
      .resolves.toEqual({ latestVersion: null, heldVersion: null });
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(fetchAgentCliLatestVersion({ runtimeSpec: runtimeSpec(), installSource: 'npm', deps: { fetchImpl } })).rejects.toThrow(/503/);
  });
});
