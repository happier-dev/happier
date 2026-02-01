import './utils/env/env.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getInvokedCwd } from './utils/cli/cwd_scope.mjs';
import { run } from './utils/proc/proc.mjs';

function getRootDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function findHappyMonorepoRoot(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, 'package.json');
    const lock = join(dir, 'yarn.lock');
    const packagesDir = join(dir, 'packages');
    if (existsSync(pkg) && existsSync(lock) && existsSync(packagesDir)) {
      try {
        // lightweight name check (don’t parse unless needed)
        const text = readFileSync(pkg, 'utf8');
        if (text.includes('"name": "monorepo"')) return dir;
      } catch {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveDockerHostEnv() {
  // Prefer Docker Desktop’s user socket on macOS.
  const desktopSock = resolve(process.env.HOME ?? '', '.docker', 'run', 'docker.sock');
  if (existsSync(desktopSock)) {
    return `unix://${desktopSock}`;
  }
  // Fallback to the classic location (often present on Linux).
  const defaultSock = '/var/run/docker.sock';
  if (existsSync(defaultSock)) {
    return `unix://${defaultSock}`;
  }
  return '';
}

async function cmdAct({ argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const rootDir = getRootDir();
  const invokedCwd = getInvokedCwd(process.env);
  const happyRoot = findHappyMonorepoRoot(invokedCwd);
  if (!happyRoot) {
    throw new Error('[ci] could not find Happy monorepo root from cwd; run from inside the happy worktree (monorepo root)');
  }

  const runner = join(happyRoot, 'scripts', 'ci', 'run-act-tests.sh');
  if (!existsSync(runner)) {
    throw new Error(`[ci] missing act runner script: ${runner}`);
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const jobArgs = positionals.slice(1); // after "act"

  const dockerHost = resolveDockerHostEnv();
  const env = {
    ...process.env,
    ...(dockerHost ? { ACT_DOCKER_SOCKET: dockerHost } : {}),
  };

  if (!json) {
    // eslint-disable-next-line no-console
    console.log(`[ci] act: ${runner}`);
    if (dockerHost) {
      // eslint-disable-next-line no-console
      console.log(`[ci] ACT_DOCKER_SOCKET=${dockerHost}`);
    }
    if (jobArgs.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[ci] jobs: ${jobArgs.join(' ')}`);
    }
  }

  await run('bash', [runner, ...jobArgs], { cwd: happyRoot, env });
  printResult({
    json,
    data: { ok: true, runner, happyRoot, dockerHost: dockerHost || null },
    text: '[ci] ✅ act ok',
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { commands: ['act'], flags: ['--json'] },
      text: ['[ci] usage:', '  hapsta ci act [job...] [--json]'].join('\n'),
    });
    return;
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const sub = positionals[0];
  if (!sub) {
    throw new Error('[ci] missing subcommand (expected: act)');
  }
  if (sub === 'act') {
    await cmdAct({ argv });
    return;
  }
  throw new Error(`[ci] unknown subcommand: ${sub} (expected: act)`);
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  });
}
