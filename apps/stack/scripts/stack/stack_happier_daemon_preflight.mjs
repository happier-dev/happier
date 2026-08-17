import { startLocalDaemonWithAuth } from '../daemon.mjs';

import { resolveStackDaemonCommandContext } from './stack_daemon_command.mjs';

export function requiresStackDaemonPreflight(childArgs) {
  const args = childArgs.map((value) => String(value ?? '').trim());
  if (args.includes('--help') || args.includes('-h')) {
    return false;
  }

  const [first = '', second = ''] = args;
  if (first === 'session' && second === 'create') {
    return true;
  }
  if (first === 'resume' || first === 'attach') {
    return true;
  }
  return false;
}

export async function ensureStackDaemonPreflight({
  rootDir,
  stackName,
  env,
  argv,
  cliIdentity = 'default',
  activeRuntimeState = null,
} = {}) {
  const daemonContext = await resolveStackDaemonCommandContext({
    rootDir,
    stackName,
    env,
    identity: cliIdentity,
    argv,
    activeRuntimeState,
  });
  await startLocalDaemonWithAuth({
    cliBin: daemonContext.cliBin,
    cliEntrypoint: daemonContext.cliEntrypoint,
    cliNodeEntrypoint: daemonContext.cliNodeEntrypoint,
    cliCommand: daemonContext.cliCommand,
    cliCommandArgs: daemonContext.cliCommandArgs,
    cliHomeDir: daemonContext.cliHomeDir,
    internalServerUrl: daemonContext.internalServerUrl,
    publicServerUrl: daemonContext.publicServerUrl,
    runtimeStatePath: daemonContext.runtimePath,
    isShuttingDown: () => false,
    forceRestart: false,
    env: daemonContext.envForIdentity,
    stackName,
    cliIdentity,
    ...daemonContext.runtimeProvenance,
  });
}
