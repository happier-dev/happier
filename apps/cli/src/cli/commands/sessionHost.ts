import type { CommandHandler } from '../commandRegistry';

/**
 * `happier session-host`: the daemon's session host (internal; launched only by the daemon spawn
 * owner). It runs each daemon-added Session's runner command through the ordinary CLI dispatch,
 * inside that Session's own scope, and holds one Account carrier for all of them.
 */
export const handleSessionHostCliCommand: CommandHandler = async (context) => {
  if (context.args.length !== 1) throw new Error('session-host takes no arguments');
  const [
    { startSessionHost, SESSION_HOST_READY_LINE },
    { dispatchCli },
    { parseCliArgs },
    { runWithRunnerHomeTransport },
    { readPublishedDaemonProcessBirth },
    { selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup },
  ] = await Promise.all([
    import('@/agent/runtime/lifecycle/sessionHost'),
    import('@/cli/dispatch'),
    import('@/cli/parseArgs'),
    import('@/api/connection/runWithRunnerHomeTransport'),
    import('@/persistence'),
    import('@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration'),
  ]);
  // The host leaves the daemon service cgroup once, as a runner does.
  await selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup();
  await runWithRunnerHomeTransport(async () => {
    const host = await startSessionHost({
      runSessionCommand: async (argv) => {
        const { args, terminalRuntime } = parseCliArgs([...argv]);
        await dispatchCli({ args, terminalRuntime, rawArgv: [...process.argv.slice(0, 2), ...argv] });
      },
      // The daemon that launched (or later adopts) this host publishes its process birth in its own state.
      readTrustedCaller: readPublishedDaemonProcessBirth,
    });
    process.stdout.write(`${SESSION_HOST_READY_LINE} ${process.pid}\n`);
    await host.whenEnded;
  }, context.signal);
};
