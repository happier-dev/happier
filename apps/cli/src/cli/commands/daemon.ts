import type { CommandContext } from '@/cli/commandRegistry';

/** Hidden worker roles dispatch before importing the normal daemon control runtime. */
export async function handleDaemonCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;
  const daemonSubcommand = args[1];

  if (daemonSubcommand === 'voice-inference-worker') {
    // Hidden subcommand: this process IS the forked voice-inference worker child. The daemon
    // spawns it via spawnHappyCLI (binary-safe) and drives it over stdio. It must not print
    // help, attach to the relay, or run any daemon control logic — just host the engine.
    const { runVoiceInferenceWorkerChild } = await import('@/daemon/voiceInference/forkedWorker/workerEntry');
    await runVoiceInferenceWorkerChild();
    process.exit(0);
  }

  if (daemonSubcommand === 'database-worker') {
    // Hidden subcommand: one daemon-database entry owns this child while its
    // synchronous SQLite driver runs here. It never joins daemon control flow.
    const { runDaemonDatabaseWorkerChild } = await import('@/plugins/runtime/context/daemonDatabaseWorkerEntry');
    await runDaemonDatabaseWorkerChild();
    process.exit(0);
  }

  if (daemonSubcommand === 'plugin-author-materialize-worker') {
    const { runPluginAuthorMaterializationChild } = await import('@/plugins/authoring/materializationProcess');
    await runPluginAuthorMaterializationChild();
    process.exit(0);
  }

  if (daemonSubcommand === 'background-service-worker') {
    const { runBackgroundServiceProcessWorkerChild } = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessWorkerEntry');
    await runBackgroundServiceProcessWorkerChild({
      async loadHostEntry() {
        const { runMemoryIndexerService } = await import('@/daemon/memory/memoryIndexerServiceEntry');
        return { run: runMemoryIndexerService };
      },
    });
    process.exit(0);
  }

  if (daemonSubcommand === 'plugin-packed-test-host') {
    // Hidden restricted daemon mode used only by the public packed-author flow.
    // It hosts the production G3 plugin owner over authenticated loopback HTTP.
    const { runPackedTestDaemonHost } = await import('@/plugins/daemon/packedTestHost');
    await runPackedTestDaemonHost(args.slice(2));
    process.exit(0);
  }

  const { handleDaemonControlCliCommand } = await import('./daemonControl');
  await handleDaemonControlCliCommand(context);
}
