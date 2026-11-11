import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { doesCliLauncherUseInstallation } from './managedCliShimInstall.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it('follows the default marker without attributing the default alias to another installed ring', () => {
  const home = mkdtempSync(join(tmpdir(), 'happier-shim-identity-'));
  homes.push(home);
  writeFileSync(join(home, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: 'preview' }));
  const matches = (executable: string, root: string) => doesCliLauncherUseInstallation({ launcher: [executable, 'daemon'], installationRoots: [join(home, root)] });
  expect(matches(join(home, 'bin/happier'), 'cli-preview')).toBe(true);
  expect(matches(join(home, 'bin/happier'), 'cli')).toBe(false);
  expect(matches(join(home, 'bin/hprev'), 'cli-preview')).toBe(true);
  expect(doesCliLauncherUseInstallation({ launcher: ['/usr/bin/node', join(home, 'cli/versions/0.2.17/dist/index.mjs')], installationRoots: [join(home, 'cli')] })).toBe(true);
});

it('compares Windows paths without case, separator, or sibling-prefix mistakes', () => {
  expect(doesCliLauncherUseInstallation({ launcher: ['c:/Users/Alice/.happier/cli/current/happier.exe'], installationRoots: ['C:\\Users\\Alice\\.happier\\cli'] })).toBe(true);
  expect(doesCliLauncherUseInstallation({ launcher: ['C:\\Users\\Alice2\\.happier\\cli\\current\\happier.exe'], installationRoots: ['C:/Users/Alice/.happier/cli'] })).toBe(false);
});

it.skipIf(process.platform !== 'win32')('resolves Windows managed aliases on their filesystem', () => {
  expect(doesCliLauncherUseInstallation({ launcher: ['C:\\Users\\Alice\\.happier\\bin\\happier.exe'], installationRoots: ['C:/Users/Alice/.happier/cli'] })).toBe(true);
});
