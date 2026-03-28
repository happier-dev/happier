// @ts-check

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { maybeUploadSentryExpoSourceMaps } from './sentry-upload-sourcemaps.mjs';
import { withEasGitCaseSensitiveEnv } from './eas-git-case-sensitive-env.mjs';
import { applyExpoNodeHeapEnv } from '../../expo/expoNodeHeapEnv.mjs';
import { normalizeInteractiveOverride, resolveExpoInteractivity } from './resolve-expo-interactivity.mjs';
import {
  MOBILE_RELEASE_ENVIRONMENT_CHOICES,
  formatMobileReleaseEnvironment,
  normalizeMobileReleaseEnvironment,
  resolveMobileBuildNodeEnvironment,
  resolveMobileAppEnvironmentConfig,
} from './mobile-release-environments.mjs';

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
  if (environment !== 'internaldev' && environment !== 'internalpreview' && environment !== 'publicdev' && environment !== 'preview') return '';

  const sha = String(process.env.GITHUB_SHA ?? '').trim() || run(opts, 'git', ['rev-parse', 'HEAD'], { stdio: 'pipe' }).trim();
  const runId = String(process.env.GITHUB_RUN_ID ?? '').trim();
  const attempt = String(process.env.GITHUB_RUN_ATTEMPT ?? '').trim();
  const laneLabel = formatMobileReleaseEnvironment(environment);
  if (runId && attempt) {
    return `Happier OTA ${laneLabel} ${sha} (run ${runId} attempt ${attempt})`;
  }
  if (runId) {
    return `Happier OTA ${laneLabel} ${sha} (run ${runId})`;
  }
  return `Happier OTA ${laneLabel} ${sha}`;
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      message: { type: 'string', default: '' },
      interactive: { type: 'string', default: 'auto' },
      'eas-cli-version': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const environment = String(values.environment ?? '').trim();
  const normalizedEnvironment = normalizeMobileReleaseEnvironment(environment);
  if (!normalizedEnvironment) {
    fail(`--environment must be ${JSON.stringify(MOBILE_RELEASE_ENVIRONMENT_CHOICES)} (got: ${environment || '<empty>'})`);
  }

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  let interactiveOverride = 'auto';
  try {
    interactiveOverride = normalizeInteractiveOverride(values.interactive);
  } catch (error) {
    fail(/** @type {Error} */ (error).message);
  }

  const interactivity = resolveExpoInteractivity({ interactiveOverride });
  const expoToken = String(process.env.EXPO_TOKEN ?? '').trim();
  if (interactivity.nonInteractive && !expoToken) {
    fail('EXPO_TOKEN is required for non-interactive Expo OTA updates.');
  }

  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';

  console.log(`[pipeline] expo ota: environment=${formatMobileReleaseEnvironment(normalizedEnvironment)}`);

  if (normalizedEnvironment === 'production') {
    run(opts, 'yarn', ['--cwd', 'apps/ui', 'ota:production'], {
      cwd: repoRoot,
      env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'production' },
    });
    return;
  }

  const uiDir = path.join(repoRoot, 'apps', 'ui');
  const appEnvironment = normalizedEnvironment;
  const updateLane = resolveMobileAppEnvironmentConfig(normalizedEnvironment).updatesChannel;
  const nodeEnvironment = resolveMobileBuildNodeEnvironment(normalizedEnvironment);
  const easCommandEnv = withEasGitCaseSensitiveEnv(
    applyExpoNodeHeapEnv({
      ...process.env,
      APP_ENV: process.env.APP_ENV ?? appEnvironment,
      NODE_ENV: process.env.NODE_ENV ?? nodeEnvironment,
      EXPO_UPDATES_CHANNEL: process.env.EXPO_UPDATES_CHANNEL ?? updateLane,
    }, {
      envKey: 'HAPPIER_PIPELINE_EXPO_MAX_OLD_SPACE_SIZE_MB',
    }),
  );
  run(opts, 'yarn', ['tsx', 'sources/scripts/parseChangelog.ts'], {
    cwd: uiDir,
    env: { ...process.env, APP_ENV: process.env.APP_ENV ?? appEnvironment, NODE_ENV: process.env.NODE_ENV ?? nodeEnvironment },
  });
  run(opts, 'yarn', ['typecheck'], { cwd: uiDir });

  const message = resolvePreviewMessage(normalizedEnvironment, values.message, opts);
  if (!message) fail(`Missing Expo update message for ${normalizedEnvironment} OTA update.`);

  run(
    opts,
    'npx',
    [
      '--yes',
      `eas-cli@${easCliVersion}`,
      'update',
      '--channel',
      updateLane,
      ...(interactivity.nonInteractive ? ['--non-interactive'] : []),
      '--message',
      message,
    ],
    {
      cwd: uiDir,
      env: easCommandEnv,
    },
  );

  const upload = maybeUploadSentryExpoSourceMaps({
    dryRun,
    uiDir,
    distDir: 'dist',
    env: process.env,
    run: (cmd, args, extra) => {
      run(opts, cmd, args, extra);
    },
  });
  if (upload.status === 'uploaded') {
    console.log('[pipeline] uploaded Sentry source maps for OTA update');
  } else if (upload.reason) {
    console.log(`[pipeline] skipped Sentry source maps upload (${upload.reason})`);
  } else {
    console.log('[pipeline] skipped Sentry source maps upload');
  }
}

main();
