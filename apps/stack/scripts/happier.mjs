import './utils/env/env.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir, getStackName } from './utils/paths/paths.mjs';
import { resolveCliHomeDir } from './utils/stack/dirs.mjs';
import { getPublicServerUrlEnvOverride, resolveServerPortFromEnv } from './utils/server/urls.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { passthrough: true },
      text: [
        '[happier] usage:',
        '  hstack happier <happier-cli args...>',
        '',
        'notes:',
        '  - This runs the monorepo CLI component (apps/cli) with stack env defaults.',
        '  - It auto-fills HAPPIER_HOME_DIR / HAPPIER_SERVER_URL / HAPPIER_WEBAPP_URL when missing.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const stackName = (process.env.HAPPIER_STACK_STACK ?? '').toString().trim() || getStackName();
  const serverPort = resolveServerPortFromEnv({ env: process.env, defaultPort: 3005 });

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const { publicServerUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort, stackName });

  const cliHomeDir = resolveCliHomeDir();

  const cliDir = getComponentDir(rootDir, 'happier-cli');
  const entrypoint = join(cliDir, 'dist', 'index.mjs');
  if (!existsSync(entrypoint)) {
    console.error(`[happier] missing CLI build at: ${entrypoint}`);
    console.error('Run: hstack bootstrap');
    process.exit(1);
  }

  const env = { ...process.env };
  env.HAPPIER_HOME_DIR = env.HAPPIER_HOME_DIR || cliHomeDir;
  env.HAPPIER_SERVER_URL = env.HAPPIER_SERVER_URL || internalServerUrl;
  env.HAPPIER_WEBAPP_URL = env.HAPPIER_WEBAPP_URL || publicServerUrl;

  const res = spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', entrypoint, ...argv], {
    stdio: 'inherit',
    env,
  });

  if (res.error) {
    const msg = res.error instanceof Error ? res.error.message : String(res.error);
    console.error(`[happier] failed to run CLI: ${msg}`);
    process.exit(1);
  }

  process.exit(res.status ?? 1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[happier] failed:', message);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
