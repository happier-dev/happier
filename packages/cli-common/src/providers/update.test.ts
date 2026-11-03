import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyProviderCliInstall, fetchProviderCliLatestVersion } from './update.js';

function writeExecutable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  return path;
}

describe.skipIf(process.platform === 'win32')('classifyProviderCliInstall', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'happier-provider-cli-update-'));
    home = join(root, 'home');
    mkdirSync(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('attributes a launcher linked into the vendor install root to the native updater', () => {
    const versioned = writeExecutable(join(home, '.local', 'share', 'claude', 'versions', '2.1.0'));
    const launcher = join(home, '.local', 'bin', 'claude');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(versioned, launcher);

    expect(classifyProviderCliInstall({
      providerId: 'claude',
      command: launcher,
      source: 'system',
      platform: 'linux',
      env: { HOME: home },
    })).toEqual({
      installSource: 'native',
      updateSupported: true,
      updateCommand: `${launcher} update`,
      nativeUpdateArgs: ['update'],
    });
  });

  it.each(['@opencode/cli', 'opencode-ai'])('proves an npm global install of %s and offers only its owner command', (packageName) => {
    const packageBin = writeExecutable(join(root, 'prefix', 'lib', 'node_modules', packageName, 'bin', 'opencode.exe'));
    const shim = join(root, 'prefix', 'bin', 'opencode');
    mkdirSync(join(root, 'prefix', 'bin'), { recursive: true });
    symlinkSync(packageBin, shim);

    expect(classifyProviderCliInstall({
      providerId: 'opencode',
      command: shim,
      source: 'system',
      platform: 'linux',
      env: { HOME: home },
    })).toEqual({
      installSource: 'npm',
      updateSupported: false,
      updateCommand: `npm install -g ${packageName}@latest`,
      nativeUpdateArgs: null,
      npmPackageName: packageName,
    });
  });

  it('recognizes the scoped package beside a Windows npm shim', () => {
    const prefix = join(home, 'AppData', 'Roaming', 'npm');
    const shim = writeExecutable(join(prefix, 'opencode.cmd'));
    mkdirSync(join(prefix, 'node_modules', '@opencode', 'cli'), { recursive: true });
    writeFileSync(join(prefix, 'node_modules', '@opencode', 'cli', 'package.json'), JSON.stringify({ name: '@opencode/cli' }));

    expect(classifyProviderCliInstall({
      providerId: 'opencode', command: shim, source: 'system', platform: 'win32', env: { USERPROFILE: home },
    })).toMatchObject({ installSource: 'npm', updateSupported: false, updateCommand: 'npm install -g @opencode/cli@latest' });
  });

  it.each([
    ['pnpm', '.local/share/pnpm/global/5', 'pnpm add -g --allow-build=@opencode/cli @opencode/cli@latest'],
    ['bun', '.bun/install/global', 'bun add -g --trust @opencode/cli@latest'],
  ] as const)('includes the vendor build approval in the %s owner command', (installSource, prefix, updateCommand) => {
    const binary = writeExecutable(join(home, prefix, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
    expect(classifyProviderCliInstall({
      providerId: 'opencode', command: binary, source: 'system', platform: 'linux', env: { HOME: home },
    })).toMatchObject({ installSource, updateSupported: false, updateCommand });
  });

  it('keeps the proven legacy package ahead of the generic PNPM_HOME hint', () => {
    const binary = writeExecutable(join(home, '.local/share/pnpm/global/5/node_modules/opencode-ai/bin/opencode'));
    const binDir = join(home, '.local/share/pnpm');
    const shim = join(binDir, 'opencode');
    symlinkSync(binary, shim);
    expect(classifyProviderCliInstall({
      providerId: 'opencode', command: shim, source: 'system', platform: 'linux',
      env: { HOME: home, PNPM_HOME: binDir },
    })).toMatchObject({ installSource: 'pnpm', updateSupported: false, updateCommand: 'pnpm add -g opencode-ai@latest' });
  });

  it('names the Homebrew cask that owns the executable', () => {
    const caskBin = writeExecutable(join(root, 'homebrew', 'Caskroom', 'claude-code', '2.1.0', 'claude'));
    const link = join(root, 'homebrew', 'bin', 'claude');
    mkdirSync(join(root, 'homebrew', 'bin'), { recursive: true });
    symlinkSync(caskBin, link);

    expect(classifyProviderCliInstall({
      providerId: 'claude',
      command: link,
      source: 'system',
      platform: 'darwin',
      env: { HOME: home },
    })).toMatchObject({
      installSource: 'brew',
      updateSupported: false,
      updateCommand: 'brew upgrade --cask claude-code',
    });
  });

  it('updates a Happier-managed install through the managed owner and leaves overrides alone', () => {
    expect(classifyProviderCliInstall({
      providerId: 'gemini',
      command: join(home, 'tools', 'gemini'),
      source: 'managed',
      platform: 'linux',
      env: { HOME: home },
    })).toEqual({ installSource: 'managed', updateSupported: true, updateCommand: null, nativeUpdateArgs: null });

    expect(classifyProviderCliInstall({
      providerId: 'claude',
      command: writeExecutable(join(root, 'custom', 'claude')),
      source: 'override',
      platform: 'linux',
      env: { HOME: home },
    })).toEqual({ installSource: 'other', updateSupported: false, updateCommand: null, nativeUpdateArgs: null });
  });
});

describe('fetchProviderCliLatestVersion', () => {
  const DAY_MS = 24 * 60 * 60_000;
  const now = Date.parse('2026-09-26T08:00:00Z');

  it('reads the npm registry latest dist-tag for npm-published agents', async () => {
    const fetchJson = vi.fn(async (_url: string) => ({ version: '1.14.2' }));

    await expect(fetchProviderCliLatestVersion({ providerId: 'claude', installSource: 'native', deps: { fetchJson } }))
      .resolves.toEqual({ latestVersion: '1.14.2', heldVersion: null });
    expect(fetchJson.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest');
  });

  it.each(['npm', 'managed'] as const)('looks up OpenCode 2 for a %s install', async (installSource) => {
    const fetchJson = vi.fn(async (_url: string) => ({ version: '2.2.5' }));
    await expect(fetchProviderCliLatestVersion({
      providerId: 'opencode', installSource, deps: { fetchJson, readMinimumReleaseAgeMs: async () => 0 },
    })).resolves.toEqual({ latestVersion: '2.2.5', heldVersion: null });
    expect(fetchJson.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/@opencode%2Fcli/latest');
  });

  it('uses the proven legacy package for its latest-version lookup', async () => {
    const fetchJson = vi.fn(async (url: string) => ({ version: url.includes('opencode-ai') ? '1.19.5' : '2.2.5' }));
    const params = {
      providerId: 'opencode' as const, installSource: 'npm' as const, npmPackageName: 'opencode-ai', deps: { fetchJson },
    };
    await expect(fetchProviderCliLatestVersion(params)).resolves.toEqual({ latestVersion: '1.19.5', heldVersion: null });
  });

  it('reads the GitHub latest release tag for release-binary agents', async () => {
    const fetchGitHubLatestRelease = vi.fn(async () => ({ tag_name: 'rust-v0.157.0' }));

    await expect(fetchProviderCliLatestVersion({
      providerId: 'codex',
      installSource: 'managed',
      deps: { fetchGitHubLatestRelease },
    })).resolves.toEqual({ latestVersion: '0.157.0', heldVersion: null });
    expect(fetchGitHubLatestRelease).toHaveBeenCalledWith(expect.objectContaining({ githubRepo: 'openai/codex' }));
  });

  it('offers a managed package only once the managed installer will take it', async () => {
    const packument = {
      'dist-tags': { latest: '0.24.6' },
      time: {
        '0.24.4': new Date(now - 9 * DAY_MS).toISOString(),
        '0.24.5': new Date(now - 3 * DAY_MS).toISOString(),
        '0.25.0-preview.1': new Date(now - 2 * DAY_MS).toISOString(),
        '0.24.6': new Date(now - 7 * 60 * 60_000).toISOString(),
      },
    };
    const fetchJson = vi.fn(async (_url: string) => packument);
    const readMinimumReleaseAgeMs = vi.fn(async () => DAY_MS);

    await expect(fetchProviderCliLatestVersion({
      providerId: 'qwen',
      installSource: 'managed',
      now: () => now,
      deps: { fetchJson, readMinimumReleaseAgeMs },
    })).resolves.toEqual({
      latestVersion: '0.24.5',
      heldVersion: { version: '0.24.6', minimumReleaseAgeMs: DAY_MS },
    });
    expect(fetchJson.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/@qwen-code%2Fqwen-code');

    // The same package installed by npm keeps npm's own "latest".
    const npmFetch = vi.fn(async (_url: string) => ({ version: '0.24.6' }));
    await expect(fetchProviderCliLatestVersion({
      providerId: 'qwen',
      installSource: 'npm',
      deps: { fetchJson: npmFetch, readMinimumReleaseAgeMs },
    })).resolves.toEqual({ latestVersion: '0.24.6', heldVersion: null });
  });

  it('returns no version when the catalog declares no latest-version source and rejects on registry failure', async () => {
    const fetchJson = vi.fn(async (_url: string): Promise<unknown> => {
      throw new Error('[http] request failed (503)');
    });

    await expect(fetchProviderCliLatestVersion({ providerId: 'kiro', installSource: 'other', deps: { fetchJson } }))
      .resolves.toEqual({ latestVersion: null, heldVersion: null });
    expect(fetchJson).not.toHaveBeenCalled();
    await expect(fetchProviderCliLatestVersion({ providerId: 'gemini', installSource: 'npm', deps: { fetchJson } }))
      .rejects.toThrow('503');
  });
});
