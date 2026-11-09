import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
import { readDefaultManagedReleaseChannel, resolveDefaultManagedReleaseChannelStatePath, writeDefaultManagedReleaseChannel } from './defaultReleaseChannelState.js';
import { uninstallManagedFirstPartyComponent } from './uninstallManagedFirstPartyComponent.js';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY } from './installLayout.js';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it.each([
  { selected: 'preview', defaultChannel: 'preview', survivor: 'stable' },
  { selected: 'preview', defaultChannel: 'stable', survivor: 'stable' },
  { selected: 'stable', defaultChannel: 'preview', survivor: 'preview' },
] as const)('removes only aliases owned by $selected when default is $defaultChannel', async ({ selected, defaultChannel, survivor }) => {
  const home = await mkdtemp(join(tmpdir(), 'happier-uninstall-alias-'));
  homes.push(home);
  const processEnv = { ...process.env, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: home };
  await writeDefaultManagedReleaseChannel({ releaseChannel: defaultChannel, processEnv });
  const preview = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'preview', processEnv });
  const stable = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'stable', processEnv });
  for (const path of [preview.binaryPath, stable.binaryPath, ...preview.shimPaths, ...stable.shimPaths]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, path === stable.shimPaths[0] ? (defaultChannel === 'preview' ? preview.binaryPath : stable.binaryPath) : path);
  }
  const selectedPaths = selected === 'preview' ? preview : stable;
  const survivorPaths = survivor === 'preview' ? preview : stable;
  const result = await uninstallManagedFirstPartyComponent({ componentId: 'happier-cli', channel: selected, processEnv });
  await expect(access(selectedPaths.installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(survivorPaths.installRoot)).resolves.toBeUndefined();
  expect(await readFile(stable.shimPaths[0]!, 'utf8')).toBe(survivorPaths.binaryPath);
  expect(await readDefaultManagedReleaseChannel({ processEnv })).toBe(survivor);
  if (selected === defaultChannel) {
    expect(result.removedPaths).toContain(stable.shimPaths[0]);
  }
});

it('removes the default alias and marker when no managed CLI survives', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-uninstall-last-'));
  homes.push(home);
  const processEnv = { ...process.env, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: home };
  await writeDefaultManagedReleaseChannel({ releaseChannel: 'preview', processEnv });
  const paths = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'preview', processEnv });
  const defaultAlias = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'stable', processEnv }).shimPaths[0]!;
  for (const path of [paths.binaryPath, ...paths.shimPaths, defaultAlias]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'installed');
  }
  await uninstallManagedFirstPartyComponent({ componentId: 'happier-cli', channel: 'preview', processEnv });
  await expect(access(defaultAlias)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(resolveDefaultManagedReleaseChannelStatePath({ processEnv }))).rejects.toMatchObject({ code: 'ENOENT' });
});
