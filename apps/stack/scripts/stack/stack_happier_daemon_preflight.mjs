import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from '../utils/proc/proc.mjs';

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
  childArgs = [],
} = {}) {
  const creatingSession = childArgs[0] === 'session' && childArgs[1] === 'create';
  try {
    const { resolveStackDaemonCommandContext } = await import('./stack_daemon_command.mjs');
    const daemonContext = await resolveStackDaemonCommandContext({
      rootDir,
      stackName,
      env,
      identity: cliIdentity,
      argv,
      activeRuntimeState,
    });
    if (creatingSession && !await targetsStackLocalMachine({ daemonContext, env, childArgs })) return;
    const startInput = {
      cliBin: daemonContext.cliBin,
      cliEntrypoint: daemonContext.cliEntrypoint,
      cliNodeEntrypoint: daemonContext.cliNodeEntrypoint,
      cliCommand: daemonContext.cliCommand,
      cliCommandArgs: daemonContext.cliCommandArgs,
      cliHomeDir: daemonContext.cliHomeDir,
      internalServerUrl: daemonContext.internalServerUrl,
      publicServerUrl: daemonContext.publicServerUrl,
      runtimeStatePath: daemonContext.runtimePath,
      ensureRunningOnly: true,
      stackName,
      cliIdentity,
      ...daemonContext.runtimeProvenance,
    };
    if (creatingSession) {
      // Startup diagnostics (including its children) must not corrupt the Action's JSON stdout.
      await run(process.execPath, [fileURLToPath(new URL('./stack_happier_daemon_preflight_start.mjs', import.meta.url))], {
        env: daemonContext.envForIdentity, input: JSON.stringify(startInput), stdio: ['pipe', 2, 2],
      });
    } else {
      const { startLocalDaemonWithAuth } = await import('../daemon.mjs');
      await startLocalDaemonWithAuth({ ...startInput, env: daemonContext.envForIdentity, isShuttingDown: () => false });
    }
  } catch (error) {
    if (!creatingSession) throw error;
    console.error('[stack] Local daemon preflight did not complete; continuing to the Session creation Action.');
  }
}

async function targetsStackLocalMachine({ daemonContext, env, childArgs }) {
  const { tokens } = parseArgs({ args: childArgs, options: {
    'machine-id': { type: 'string' }, 'server-id': { type: 'string' },
  }, strict: false, allowPositionals: true, tokens: true });
  // The CLI's flag reader uses the first occurrence, not the last.
  const machineOption = tokens.find(token => token.kind === 'option' && token.name === 'machine-id')?.value;
  const serverOption = tokens.find(token => token.kind === 'option' && token.name === 'server-id')?.value;
  const serverId = daemonContext.scopedEnvForIdentity.HAPPIER_ACTIVE_SERVER_ID;
  if (!serverId || (env.HAPPIER_ACTIVE_SERVER_ID && env.HAPPIER_ACTIVE_SERVER_ID !== serverId)
    || (serverOption && serverOption !== serverId)
    || (env.HAPPIER_HOME_DIR && resolve(env.HAPPIER_HOME_DIR) !== resolve(daemonContext.cliHomeDir))) return false;
  // Installed identity determines whether this stack can start the local daemon.
  const { readReleasedMachineRegistrations, readStoredMachineRegistration, resolveMachineRegistrationPath,
    resolveRegisteredMachineId } = await import('@happier-dev/cli-common/firstPartyRuntime/cliMachineRegistration');
  const path = resolveMachineRegistrationPath(join(daemonContext.cliHomeDir, 'servers'), serverId);
  const stored = await readStoredMachineRegistration(path);
  // Stack can preflight before the installed CLI first upgrades a released Home.
  const registration = stored ?? (await readReleasedMachineRegistrations(join(daemonContext.cliHomeDir, 'settings.json'))).get(serverId);
  const machineId = registration && resolveRegisteredMachineId(registration);
  return Boolean(machineId && (!machineOption || machineOption.trim() === machineId));
}
