import { runHeartbeatWrappedCommand, resolveSignalExitCode } from './runPlaywrightWithHeartbeat.shared.mjs';
import { resolveWsreplLimaMatrixInvocation } from './runWsreplLimaMatrix.shared.mjs';

const invocation = resolveWsreplLimaMatrixInvocation({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
});

if (!invocation.ok) {
  // eslint-disable-next-line no-console
  console.error(invocation.message);
  process.exit(invocation.exitCode);
}

await runHeartbeatWrappedCommand({
  toolName: 'wsrepl-lima-matrix',
  config: invocation.configLabel,
  command: invocation.command,
  args: invocation.args,
  spawnOptions: invocation.spawnOptions,
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
