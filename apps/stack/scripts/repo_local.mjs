import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  return [
    '[repo-local] usage:',
    '  node apps/stack/scripts/repo_local.mjs <hstack-subcommand> [args...]',
    '',
    'examples:',
    '  node apps/stack/scripts/repo_local.mjs dev',
    '  node apps/stack/scripts/repo_local.mjs start --restart',
    '  node apps/stack/scripts/repo_local.mjs tui dev',
    '',
    'notes:',
    '  - Forces using this repo checkout (no re-exec to global hstack install).',
    '  - Does not select a stack; hstack will run in stackless mode and infer repo from CWD.',
    '  - Use --dry-run to print the resolved invocation as JSON.',
  ].join('\n');
}

function main() {
  const argvRaw = process.argv.slice(2);
  if (argvRaw.includes('--help') || argvRaw.includes('-h') || argvRaw[0] === 'help' || argvRaw.length === 0) {
    process.stdout.write(usage() + '\n');
    process.exit(argvRaw.length === 0 ? 1 : 0);
  }

  const dryRun = argvRaw.includes('--dry-run');
  const argv = argvRaw.filter((a) => a !== '--dry-run');

  const scriptsDir = dirname(fileURLToPath(import.meta.url)); // <repo>/apps/stack/scripts
  const repoRoot = dirname(dirname(dirname(scriptsDir))); // <repo>
  const hstackBin = join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');

  const invokedCwd =
    (process.env.HAPPIER_STACK_INVOKED_CWD ?? '').toString().trim() ||
    (process.env.INIT_CWD ?? '').toString().trim() ||
    process.cwd();

  // Force "repo-local" behavior:
  // - avoid re-exec into any global install
  // - avoid pinning to a configured repo dir (infer from invoked cwd)
  // - avoid stack selection (stackless mode)
  const env = {
    ...process.env,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_CLI_ROOT_DIR: repoRoot,
    HAPPIER_STACK_REPO_DIR: '',
    HAPPIER_STACK_STACK: '',
    HAPPIER_STACK_INVOKED_CWD: invokedCwd,
  };

  const cmd = process.execPath;
  const args = [hstackBin, ...argv];
  const cwd = repoRoot;

  if (dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          cmd,
          args,
          cwd,
          env: {
            HAPPIER_STACK_CLI_ROOT_DISABLE: env.HAPPIER_STACK_CLI_ROOT_DISABLE,
            HAPPIER_STACK_CLI_ROOT_DIR: env.HAPPIER_STACK_CLI_ROOT_DIR,
            HAPPIER_STACK_REPO_DIR: env.HAPPIER_STACK_REPO_DIR,
            HAPPIER_STACK_STACK: env.HAPPIER_STACK_STACK,
            HAPPIER_STACK_INVOKED_CWD: env.HAPPIER_STACK_INVOKED_CWD,
          },
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const res = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

main();
