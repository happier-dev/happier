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
    { createSessionHostCredentialHold },
  ] = await Promise.all([
    import('@/agent/runtime/lifecycle/sessionHost'),
    import('@/cli/dispatch'),
    import('@/cli/parseArgs'),
    import('@/api/connection/runWithRunnerHomeTransport'),
    import('@/persistence'),
    import('@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration'),
    import('@/agent/runtime/lifecycle/sessionHostCredentialHold'),
  ]);
  // Account credentials read once per (Home, Account) for this host, checked against each add.
  const credentialHold = createSessionHostCredentialHold();
  // The host leaves the daemon service cgroup once, as a runner does.
  await selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup();
  await runWithRunnerHomeTransport(async () => {
    const host = await startSessionHost({
      runSessionCommand: async (argv, launch) => {
        const { args, terminalRuntime } = parseCliArgs([...argv]);
        // The daemon already admitted this Session's Account and Machine: its command re-derives neither.
        let credentials: Awaited<ReturnType<typeof credentialHold.resolve>> | null = null;
        if (launch.account) {
          try {
            credentials = await credentialHold.resolve(launch.account);
          } catch (error) {
            // A Session admitted for another Account than the one signed in here: end it with its typed cause.
            const { reportSessionRunnerFailure } = await import('@/cli/resolveSessionRunnerFailureExitCode');
            const { endSessionCommand } = await import('@/agent/runtime/lifecycle/runnerTerminationHandlers');
            endSessionCommand(reportSessionRunnerFailure(error));
            return;
          }
        }
        const sessionStart = launch.account && credentials
          ? { credentials, machineId: launch.account.machineId,
              ...(launch.account.settingsVersion === undefined ? {} : { accountSettingsVersionFloor: launch.account.settingsVersion }) }
          : undefined;
        await dispatchCli({ args, terminalRuntime, rawArgv: [...process.argv.slice(0, 2), ...argv],
          ...(sessionStart ? { sessionStart } : {}) });
      },
      // The daemon that launched (or later adopts) this host publishes its process birth in its own state.
      readTrustedCaller: readPublishedDaemonProcessBirth,
    });
    process.stdout.write(`${SESSION_HOST_READY_LINE} ${process.pid}\n`);
    await host.whenEnded;
  }, context.signal);
};
