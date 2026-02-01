import './utils/env/env.mjs';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { getComponentDir, getHappyStacksHomeDir, getRepoDir, getRootDir, getStackLabel, getStackName, getWorkspaceDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRuntimeDir } from './utils/paths/runtime.mjs';
import { getCanonicalHomeDir, getCanonicalHomeEnvPath } from './utils/env/config.mjs';
import { getSandboxDir } from './utils/env/sandbox.mjs';
import { banner, bullets, kv, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim } from './utils/ui/ansi.mjs';
import { getWorktreesRoot } from './utils/git/worktrees.mjs';

function getHomeEnvPaths() {
  const homeDir = getHappyStacksHomeDir();
  return {
    homeEnv: join(homeDir, '.env'),
    homeLocal: join(homeDir, 'env.local'),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags }) || argv.includes('help')) {
    printResult({
      json,
      data: { flags: ['--json'], commands: ['where'] },
      text: ['[where] usage:', '  hstack where [--json]'].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const homeDir = getHappyStacksHomeDir();
  const canonicalHomeDir = getCanonicalHomeDir();
  const canonicalEnv = getCanonicalHomeEnvPath();
  const sandboxDir = getSandboxDir();
  const runtimeDir = getRuntimeDir();
  const workspaceDir = getWorkspaceDir(rootDir);
  const repoDir = getRepoDir(rootDir);
  const worktreesDir = getWorktreesRoot(rootDir);

  const stackName = getStackName();
  const stackLabel = getStackLabel(stackName);
  const resolvedMainEnv = resolveStackEnvPath('main');
  const resolvedActiveEnv = process.env.HAPPIER_STACK_ENV_FILE?.trim()
    ? { envPath: expandHome(process.env.HAPPIER_STACK_ENV_FILE.trim()) }
    : null;

  const { homeEnv, homeLocal } = getHomeEnvPaths();
  const updateCachePath = join(homeDir, 'cache', 'update.json');

  const packageNames = ['happy', 'happy-cli', 'happy-server'];
  const packageDirs = Object.fromEntries(packageNames.map((name) => [name, getComponentDir(rootDir, name)]));

  printResult({
    json,
    data: {
      ok: true,
      rootDir,
      sandbox: sandboxDir ? { enabled: true, dir: sandboxDir } : { enabled: false },
      homeDir,
      canonicalHomeDir,
      runtimeDir,
      workspaceDir,
      repoDir,
      worktreesDir,
      stack: { name: stackName, label: stackLabel },
      envFiles: {
        canonical: { path: canonicalEnv, exists: existsSync(canonicalEnv) },
        homeEnv: { path: homeEnv, exists: existsSync(homeEnv) },
        homeLocal: { path: homeLocal, exists: existsSync(homeLocal) },
        active: resolvedActiveEnv ? { path: resolvedActiveEnv.envPath, exists: existsSync(resolvedActiveEnv.envPath) } : null,
        main: { path: resolvedMainEnv.envPath, exists: existsSync(resolvedMainEnv.envPath) },
      },
      packages: packageDirs,
      update: {
        enabled: (process.env.HAPPIER_STACK_UPDATE_CHECK ?? '1') !== '0',
        cachePath: updateCachePath,
        cacheExists: existsSync(updateCachePath),
      },
    },
    text: [
      '',
      banner('where', { subtitle: 'Resolved paths and env sources.' }),
      '',
      sectionTitle('Paths'),
      bullets([
        kv('root:', rootDir),
        sandboxDir ? kv('sandbox:', sandboxDir) : null,
        kv('canonical:', canonicalHomeDir),
        kv('home:', homeDir),
        kv('runtime:', runtimeDir),
        kv('workspace:', workspaceDir),
        kv('repo:', repoDir),
        kv('worktrees:', worktreesDir),
      ].filter(Boolean)),
      '',
      sectionTitle('Active stack'),
      bullets([kv('stack:', `${cyan(stackName)} (${stackLabel})`)]),
      '',
      sectionTitle('Env files'),
      bullets([
        kv('canonical pointer:', existsSync(canonicalEnv) ? canonicalEnv : `${canonicalEnv} ${dim('(missing)')}`),
        kv('home defaults:', existsSync(homeEnv) ? homeEnv : `${homeEnv} ${dim('(missing)')}`),
        kv('home overrides:', existsSync(homeLocal) ? homeLocal : `${homeLocal} ${dim('(missing)')}`),
        kv('active:', resolvedActiveEnv?.envPath ? resolvedActiveEnv.envPath : dim('(none)')),
        kv('main:', resolvedMainEnv.envPath),
      ]),
      '',
      sectionTitle('Repo packages'),
      bullets(packageNames.map((n) => kv(n + ':', packageDirs[n]))),
      '',
      sectionTitle('Update'),
      bullets([kv('cache:', updateCachePath)]),
      '',
    ].join('\n'),
  });
}

main().catch((err) => {
  console.error('[where] failed:', err);
  process.exit(1);
});
