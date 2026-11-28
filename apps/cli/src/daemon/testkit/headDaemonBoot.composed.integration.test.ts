import { join } from 'node:path';
import { it } from 'vitest';
import { startInstalledDaemonFixture } from './installedDaemon.composed.testkit';

// Invoked by Stack's HEAD graph after the canonical revision producer settles.
// An ordinary integration run does not start a second daemon for this probe.
// The sentinel owns cancellation; a generic integration-test deadline must not
// turn cold fixture preparation into a false HEAD-boot failure.
it.skipIf(!process.env.HAPPIER_HEAD_DAEMON_ENTRY)('boots the captured CLI through real Machine route registration', { timeout: 0 }, async () => {
  const entrypoint = process.env.HAPPIER_HEAD_DAEMON_ENTRY!;
  // Trusted producer output, transported only between this graph and fixture.
  const runtimeEnv = JSON.parse(process.env.HAPPIER_HEAD_DAEMON_RUNTIME_ENV ?? '{}') as NodeJS.ProcessEnv;
  const launcherUrl = new URL('../../../../stack/scripts/perf/head-daemon-boot.mjs', import.meta.url).href;
  const { launchHeadDaemon, HEAD_DAEMON_BOOT_READY }: { HEAD_DAEMON_BOOT_READY: string; launchHeadDaemon: (input: Readonly<{
    entrypoint: string; env: NodeJS.ProcessEnv; cwd: string;
  }>) => Promise<Readonly<{ pid: number; completion: Promise<void>; stop: () => void }>> } = await import(launcherUrl);
  const fixture = await startInstalledDaemonFixture({
    launchDaemon: async ({ homeDirectory }) => {
      // Forward only this fixture's selected transport and lifecycle inputs.
      // Runner dotenv/Stack/provider overrides are not daemon test inputs.
      const env: NodeJS.ProcessEnv = Object.fromEntries([
        'PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LANG',
        'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_CARRIER_POLICY', 'HAPPIER_VARIANT',
        'HAPPIER_DAEMON_WAIT_FOR_AUTH', 'HAPPIER_DAEMON_STARTUP_SOURCE', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
        'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK', 'HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED',
        'HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED',
      ].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
      return await launchHeadDaemon({ entrypoint,
        env: { ...env, ...runtimeEnv, HOME: homeDirectory, USERPROFILE: homeDirectory,
          XDG_CONFIG_HOME: homeDirectory, XDG_DATA_HOME: homeDirectory, XDG_CACHE_HOME: homeDirectory,
          APPDATA: homeDirectory, LOCALAPPDATA: homeDirectory,
          HAPPIER_HOME_DIR: homeDirectory, HAPPIER_STACK_CLI_HOME_DIR: homeDirectory,
          HAPPIER_FIRST_PARTY_INSTALL_HOME: join(homeDirectory, 'native'),
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDirectory,
          HAPPIER_CLI_RUNTIME_DISABLE: '1', HAPPIER_CLI_UPDATE_CHECK: '0',
          HAPPIER_CLI_DIST_INTEGRITY_PROBE: undefined, NODE_OPTIONS: undefined, NODE_PATH: undefined },
        cwd: homeDirectory,
      });
    },
  });
  // Fixture readiness observes real RPC receivers; both are registered after
  // startDaemon's Machine route attachments. Graceful stop owns all its workers.
  console.log(HEAD_DAEMON_BOOT_READY);
  await fixture.stop();
});
