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
        '[happy] usage:',
        '  hapsta happy <happy-cli args...>',
        '',
        'notes:',
        '  - This runs the `happy-cli` component from your configured workspace/components.',
        '  - It auto-fills HAPPY_HOME_DIR / HAPPY_SERVER_URL / HAPPY_WEBAPP_URL when missing.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const stackName =
    (process.env.HAPPIER_STACK_STACK ?? '').toString().trim() || getStackName();
  const serverPort = resolveServerPortFromEnv({ env: process.env, defaultPort: 3005 });

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const { publicServerUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort, stackName });

  const cliHomeDir = resolveCliHomeDir();

  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const entrypoint = join(cliDir, 'dist', 'index.mjs');
  if (!existsSync(entrypoint)) {
    console.error(`[happy] missing happy-cli build at: ${entrypoint}`);
    console.error('Run: hapsta bootstrap');
    process.exit(1);
  }

  const env = { ...process.env };
  env.HAPPY_HOME_DIR = env.HAPPY_HOME_DIR || cliHomeDir;
  env.HAPPY_SERVER_URL = env.HAPPY_SERVER_URL || internalServerUrl;
  env.HAPPY_WEBAPP_URL = env.HAPPY_WEBAPP_URL || publicServerUrl;

  const res = spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', entrypoint, ...argv], {
    stdio: 'inherit',
    env,
  });

  if (res.error) {
    const msg = res.error instanceof Error ? res.error.message : String(res.error);
    console.error(`[happy] failed to run happy-cli: ${msg}`);
    process.exit(1);
  }

  process.exit(res.status ?? 1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[happy] failed:', message);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
