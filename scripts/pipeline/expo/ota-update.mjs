// @ts-check

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string>; stdio?: 'inherit' | 'pipe' }} [extra]
 * @returns {string}
 */
function run(opts, cmd, args, extra) {
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return '';
  }

  return execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...(extra?.env ?? {}) },
    encoding: 'utf8',
    stdio: extra?.stdio ?? 'inherit',
    timeout: 30 * 60_000,
  });
}

/**
 * @param {string} environment
 */
function resolvePreviewMessage(environment, rawMessage, opts) {
  const explicit = String(rawMessage ?? '').trim();
  if (explicit) return explicit;
  if (environment !== 'preview') return '';

  const sha = String(process.env.GITHUB_SHA ?? '').trim() || run(opts, 'git', ['rev-parse', 'HEAD'], { stdio: 'pipe' }).trim();
  const runId = String(process.env.GITHUB_RUN_ID ?? '').trim();
  const attempt = String(process.env.GITHUB_RUN_ATTEMPT ?? '').trim();
  if (runId && attempt) {
    return `Happier OTA preview ${sha} (run ${runId} attempt ${attempt})`;
  }
  if (runId) {
    return `Happier OTA preview ${sha} (run ${runId})`;
  }
  return `Happier OTA preview ${sha}`;
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      message: { type: 'string', default: '' },
      'eas-cli-version': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const environment = String(values.environment ?? '').trim();
  if (!environment) fail('--environment is required');
  if (environment !== 'preview' && environment !== 'production') {
    fail(`--environment must be 'preview' or 'production' (got: ${environment})`);
  }

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const expoToken = String(process.env.EXPO_TOKEN ?? '').trim();
  if (!expoToken) {
    fail('EXPO_TOKEN is required for Expo OTA updates.');
  }

  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';

  console.log(`[pipeline] expo ota: environment=${environment}`);

  if (environment === 'production') {
    run(opts, 'yarn', ['--cwd', 'apps/ui', 'ota:production'], {
      cwd: repoRoot,
      env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'production' },
    });
    return;
  }

  const uiDir = path.join(repoRoot, 'apps', 'ui');
  run(opts, 'yarn', ['tsx', 'sources/scripts/parseChangelog.ts'], {
    cwd: uiDir,
    env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'preview', NODE_ENV: process.env.NODE_ENV ?? 'preview' },
  });
  run(opts, 'yarn', ['typecheck'], { cwd: uiDir });

  const message = resolvePreviewMessage(environment, values.message, opts);
  if (!message) fail('Missing Expo update message for preview OTA update.');

  run(
    opts,
    'npx',
    ['--yes', `eas-cli@${easCliVersion}`, 'update', '--branch', 'preview', '--non-interactive', '--message', message],
    { cwd: uiDir },
  );
}

main();

