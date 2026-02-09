import { join } from 'node:path';
import { run } from '../utils/proc/proc.mjs';
import { listAllStackNames } from '../utils/stack/stacks.mjs';
import { getRuntimePortExtraEnv, withStackEnv } from './stack_environment.mjs';

export async function cmdService({ rootDir, stackName, svcCmd }) {
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'service.mjs'), svcCmd], { cwd: rootDir, env });
    },
  });
}

export async function cmdTailscale({ rootDir, stackName, subcmd, args }) {
  const extraEnv = await getRuntimePortExtraEnv(stackName);
  await withStackEnv({
    stackName,
    ...(extraEnv ? { extraEnv } : {}),
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'tailscale.mjs'), subcmd, ...args], { cwd: rootDir, env });
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
  const extraEnv = await getRuntimePortExtraEnv(stackName);
  await withStackEnv({
    stackName,
    ...(extraEnv ? { extraEnv } : {}),
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

export async function cmdListStacks() {
  try {
    const names = (await listAllStackNames()).filter((n) => n !== 'main');
    if (!names.length) {
      console.log('[stack] no stacks found');
      return;
    }
    console.log('[stack] stacks:');
    for (const n of names) {
      console.log(`- ${n}`);
    }
  } catch {
    console.log('[stack] no stacks found');
  }
}
