import { join } from 'node:path';
import { run } from '../utils/proc/proc.mjs';
import { withStackEnv } from './stack_environment.mjs';
import { resolveRemoteStackAuthPlacement, runRemoteStackCommand } from './remote_stack_operation.mjs';
import { buildRemoteStackOperationCommand, usesRetainedRemoteStackState } from '../utils/dev_targets/remote_commands.mjs';
import { buildAuthSafeStackStartSpec } from '../utils/auth/buildAuthSafeStackStartSpec.mjs';

export async function cmdService({ rootDir, stackName, svcCmd, args = [] }) {
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'service.mjs'), svcCmd, ...args], { cwd: rootDir, env });
    },
  });
}

export async function cmdRuntime({ rootDir, stackName, runtimeCommand, args = [] }) {
  const scriptName = runtimeCommand === 'select' ? 'runtime_select.mjs' : 'runtime_activate.mjs';
  await withStackEnv({
    stackName,
    // Selecting an already-published snapshot must only update this consumer's
    // runtime selection. Do not let generic command setup reconcile its daemon
    // membership as an incidental write.
    reconcileDaemonRuntimeState: runtimeCommand !== 'select',
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', scriptName), ...args], { cwd: rootDir, env });
    },
  });
}

export async function cmdTailscale({ rootDir, stackName, subcmd, args }) {
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'tailscale.mjs'), subcmd, ...forwarded], { cwd: rootDir, env });
    },
  });
}

export async function cmdSrv({ rootDir, stackName, args }) {
  // Forward to scripts/server_flavor.mjs under the stack env.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'server_flavor.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

export async function cmdWt({ rootDir, stackName, args }) {
  // Forward to scripts/worktrees.mjs under the stack env.
  // This makes `hstack stack wt <name> -- ...` behave exactly like `hstack wt ...`,
  // but read/write the stack env file (HAPPIER_STACK_ENV_FILE) instead of repo env.local.
  let forwarded = args[0] === '--' ? args.slice(1) : args;

  // Stack users usually want to see what *this stack* is using (active checkout),
  // not an exhaustive enumeration of every worktree on disk.
  //
  // `hstack wt list` defaults to showing all worktrees. In stack mode, default to
  // an active-only view unless the caller opts into `--all`.
  if (forwarded[0] === 'list') {
    const wantsAll = forwarded.includes('--all') || forwarded.includes('--all-worktrees');
    const wantsActive = forwarded.includes('--active') || forwarded.includes('--active-only');
    if (!wantsAll && !wantsActive) {
      forwarded = [...forwarded, '--active'];
    }
  }

  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

export async function cmdAuth({ rootDir, stackName, args }) {
  // Forward to scripts/auth.mjs under the stack env.
  // This makes `hstack stack auth <name> ...` resolve CLI home/urls for that stack.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env, runtimeState }) => {
      const placed = await resolveRemoteStackAuthPlacement({ stackName, env, runtimeState, argv: forwarded });
      if (placed && usesRetainedRemoteStackState(placed.runtimeMode)) {
        const startIfNeeded = forwarded.includes('--start-if-needed')
          && !forwarded.some(arg => ['--print', '--help', '-h'].includes(arg));
        if (startIfNeeded) {
          // Placement belongs to the controller. The native login owns its
          // retained auth home, which may be on a different host to the server.
          // Keep that host's connection provisioned; auth-flow admission already
          // defers its daemon until native sign-in is available.
          const start = buildAuthSafeStackStartSpec({ rootDir, stackName,
            shouldUseRuntimeStart: true, runtimeMode: placed.runtimeMode, startDaemon: true, baseEnv: env });
          await run(...start.args, { cwd: rootDir, env: start.env });
        }
        const remoteCommand = buildRemoteStackOperationCommand(placed.target, { stackName,
          runtimeMode: placed.runtimeMode, operation: 'auth',
          passthrough: startIfNeeded ? forwarded.filter(arg => arg !== '--start-if-needed') : forwarded });
        process.exit(await runRemoteStackCommand({ target: placed.target, stackName, remoteCommand, env }));
      }
      await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}
