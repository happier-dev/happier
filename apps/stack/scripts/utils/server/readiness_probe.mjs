import '../../../bin/localSourceRuntimeBootstrap.mjs';

// Run the existing authenticated readiness owner beside the retained CLI home.
// Auth material never crosses stdout or the controller's scope.
const { waitForServerReady } = await import('./server.mjs');
const { withStackEnv } = await import('../../stack/stack_environment.mjs');
await withStackEnv({
  stackName: process.env.HAPPIER_STACK_STACK,
  reconcileDaemonRuntimeState: false,
  fn: async ({ env }) => waitForServerReady(process.argv[2], {
    timeoutMs: Number(process.argv[3]),
    intervalMs: 500,
    env,
    cliHomeDir: env.HAPPIER_STACK_CLI_HOME_DIR,
  }),
});
process.exit(0);
