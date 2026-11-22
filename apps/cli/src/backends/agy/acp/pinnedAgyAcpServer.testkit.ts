import type crossSpawn from 'cross-spawn';
import type { SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { vi, type MockInstance } from 'vitest';

import { AGY_ACP_SERVER_VERSION } from '@happier-dev/protocol';
import { agyAcpInstallDir } from '@/capabilities/deps/agyAcp';
import { configuration } from '@/configuration';
import { resolveAgyAcpReleaseAsset } from '@/runtime/managedTools/providers/agyAcpRelease';

const pinnedFixtureCommands = new Set<string>();

/** The fake Windows asset has script bytes. Use the runtime only for fixture paths at the spawn boundary. */
export function wrapPinnedFixtureSpawn(spawn: typeof crossSpawn): typeof crossSpawn {
  const wrapped: typeof crossSpawn = Object.assign(
    (command: string, argsOrOptions?: Parameters<typeof crossSpawn>[1] | Parameters<typeof crossSpawn>[2],
      options?: Parameters<typeof crossSpawn>[2]) => {
      if (Array.isArray(argsOrOptions)) {
        return process.platform === 'win32' && pinnedFixtureCommands.has(command)
          ? spawn(process.execPath, [command, ...argsOrOptions], options)
          : spawn(command, argsOrOptions, options);
      }
      return spawn(command, (argsOrOptions as SpawnOptions | undefined) ?? {});
    },
    spawn,
  );
  return wrapped;
}

const HOME_CONFIGURATION_KEYS = ['happyHomeDir', 'logsDir', 'settingsFile'] as const;

/**
 * Runs `run` against a temporary Happier home, which owns managed installs, settings and logs.
 * Installation downloads throw, so the pinned server is only available once a test installs it.
 */
export async function withIsolatedHappierHome(run: (home: string, downloadRequest: MockInstance) => Promise<void>): Promise<void> {
  // Patch the real OS HTTP adapter, including native ESM bindings in external dependencies.
  const downloadRequest = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected installation download'); });
  syncBuiltinESMExports();
  const home = await mkdtemp(join(tmpdir(), 'happier-agy-home-'));
  const descriptors = HOME_CONFIGURATION_KEYS.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
  Object.defineProperties(configuration, {
    happyHomeDir: { value: home, configurable: true },
    logsDir: { value: join(home, 'logs'), configurable: true },
    settingsFile: { value: join(home, 'settings.json'), configurable: true },
  });
  try {
    await run(home, downloadRequest);
  } finally {
    HOME_CONFIGURATION_KEYS.forEach((key, index) => Object.defineProperty(configuration, key, descriptors[index]));
    for (const command of pinnedFixtureCommands) {
      if (command.startsWith(join(home, 'tools') + sep)) pinnedFixtureCommands.delete(command);
    }
    downloadRequest.mockRestore();
    syncBuiltinESMExports();
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Installs `source` as the verified pinned `agy_acp_server` of the current Happier home and returns
 * the launch Happier derives for it. The pinned launch executes the file directly, so `source`
 * needs a shebang.
 */
export async function installPinnedAgyAcpServerFixture(source: string): Promise<Readonly<{ command: string; args: readonly string[] }>> {
  const asset = resolveAgyAcpReleaseAsset();
  const command = join(agyAcpInstallDir(), 'current', asset.executableSubpath);
  await mkdir(dirname(command), { recursive: true });
  await writeFile(command, source);
  pinnedFixtureCommands.add(command);
  await chmod(command, 0o755);
  const metadata = await stat(command);
  await writeFile(join(agyAcpInstallDir(), 'install-state.json'), JSON.stringify({
    installedVersion: AGY_ACP_SERVER_VERSION,
    executableSha256: createHash('sha256').update(source).digest('hex'),
    executableSize: metadata.size,
    executableMtimeMs: metadata.mtimeMs,
  }));
  return { command, args: asset.args };
}
