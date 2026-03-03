import './utils/env/env.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir, getStackName } from './utils/paths/paths.mjs';
import { resolveCliHomeDir } from './utils/stack/dirs.mjs';
import { getPublicServerUrlEnvOverride, resolveServerPortFromEnv } from './utils/server/urls.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';

function printHstackHappierHelp({ json }) {
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
      '',
      'stack wrapper options:',
      '  --stack-help  Show this wrapper help (use -h/--help for CLI help)',
    ].join('\n'),
  });
}

function hasExplicitServerSelectionArg(argv) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : [];
  const check = (name) => args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
  return (
    check('--server') ||
    check('--server-url') ||
    check('--webapp-url') ||
    check('--public-server-url')
  );
}

function readArgValue(argv, flagName) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : [];
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i];
    if (arg === flagName) {
      const next = args[i + 1];
      const value = String(next ?? '').trim();
      return value || null;
    }
    if (arg.startsWith(`${flagName}=`)) {
      const value = arg.slice(flagName.length + 1).trim();
      return value || null;
    }
  }
  return null;
}

function normalizeServerUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function deriveEnvServerIdFromUrl(url) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return null;
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (flags.has('--stack-help')) {
    printHstackHappierHelp({ json });
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
  if (wantsHelp(argv, { flags }) && !existsSync(entrypoint)) {
    printHstackHappierHelp({ json });
    return;
  }
  if (!existsSync(entrypoint)) {
    console.error(`[happier] missing CLI build at: ${entrypoint}`);
    console.error('Run: hstack bootstrap');
    process.exit(1);
  }

  let env = { ...process.env };
  env.HAPPIER_HOME_DIR = env.HAPPIER_HOME_DIR || cliHomeDir;
  env.HAPPIER_SERVER_URL = env.HAPPIER_SERVER_URL || internalServerUrl;
  env.HAPPIER_WEBAPP_URL = env.HAPPIER_WEBAPP_URL || publicServerUrl;
  if (hasExplicitServerSelectionArg(argv)) {
    // If the user explicitly selects a server/profile, do not force a stack-stable active server id.
    // Otherwise credentials can be resolved from the wrong per-server directory, causing 401s.
    const explicitServerUrl =
      readArgValue(argv, '--server-url')
      || readArgValue(argv, '--public-server-url')
      || null;
    const derived = explicitServerUrl ? deriveEnvServerIdFromUrl(explicitServerUrl) : null;
    if (derived) {
      env.HAPPIER_ACTIVE_SERVER_ID = derived;
    } else {
      delete env.HAPPIER_ACTIVE_SERVER_ID;
    }
  } else {
    env = applyStackActiveServerScopeEnv({
      env,
      stackName,
      cliIdentity: (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default',
    });
  }

  const forwardedArgv = argv.filter((a) => a !== '--stack-help');
  const res = spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', entrypoint, ...forwardedArgv], {
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
