// @ts-check

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { maybeUploadSentryExpoSourceMaps } from './sentry-upload-sourcemaps.mjs';
import { withEasGitCaseSensitiveEnv } from './eas-git-case-sensitive-env.mjs';
import { applyExpoNodeHeapEnv } from '../../expo/expoNodeHeapEnv.mjs';
import { normalizeInteractiveOverride, resolveExpoInteractivity } from './resolve-expo-interactivity.mjs';
import { resolveEasBuildProfileEnv } from './resolve-eas-build-profile-env.mjs';
import {
  MOBILE_RELEASE_ENVIRONMENT_CHOICES,
  formatMobileReleaseEnvironment,
  normalizeMobileReleaseEnvironment,
  resolveMobileBuildNodeEnvironment,
  resolveMobileAppEnvironmentConfig,
} from './mobile-release-environments.mjs';

const OTA_IDENTITY_ENV_KEYS = Object.freeze([
  'EXPO_APP_NAME',
  'EXPO_APP_BUNDLE_ID',
  'EXPO_ANDROID_PACKAGE',
  'EXPO_APP_SCHEME',
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseNonNegativeInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) return;
  // Sync sleep keeps this script dependency-free and avoids refactoring the caller to async.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function resolveOtaRetrySettings(env) {
  const maxRetries = parseNonNegativeInt(env?.HAPPIER_PIPELINE_EXPO_OTA_MAX_RETRIES) ?? 3;
  const baseDelayMs = parseNonNegativeInt(env?.HAPPIER_PIPELINE_EXPO_OTA_RETRY_DELAY_MS) ?? 5_000;
  return { maxRetries, baseDelayMs };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function stringifyExecOutput(err) {
  if (!err || typeof err !== 'object') return '';
  const stdout = /** @type {any} */ (err).stdout;
  const stderr = /** @type {any} */ (err).stderr;
  const raw = [
    typeof stdout === 'string' ? stdout : Buffer.isBuffer(stdout) ? stdout.toString('utf8') : '',
    typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '',
    typeof /** @type {any} */ (err).message === 'string' ? /** @type {any} */ (err).message : '',
  ]
    .filter(Boolean)
    .join('\n');
  return String(raw ?? '');
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientEasUpdateFailure(err) {
  const raw = stringifyExecOutput(err);
  if (!raw) return false;
  return (
    raw.includes('Service Unavailable')
    || raw.includes('GraphQL request failed')
    || raw.includes('Request failed with status code 503')
    || raw.includes('ECONNRESET')
    || raw.includes('ETIMEDOUT')
    || raw.includes('socket hang up')
  );
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

function pickNonEmptyString(raw) {
  const value = String(raw ?? '').trim();
  return value ? value : '';
}

/**
 * OTA updates must be generated with the same env inputs as the corresponding native build profile;
 * otherwise iOS/Android builds won't be eligible to download the update. We also support an explicit
 * runtimeVersion override for maintenance trains that need to target an older store binary.
 *
 * We merge the EAS build-profile env (following `extends`) from `apps/ui/eas.json`, and then
 * backfill identity env (name/bundle/package/scheme) from the canonical app environment config.
 * This keeps OTA and native builds aligned, while still being robust when older build profiles
 * do not set all identity overrides explicitly (for example `EXPO_ANDROID_PACKAGE`).
 *
 * @param {string} uiDir
 * @param {import('./mobile-release-environments.mjs').MobileReleaseEnvironment} environment
 */
function resolveOtaFingerprintEnv(uiDir, environment) {
  const easJsonPath = path.join(uiDir, 'eas.json');
  const easProfileEnv = resolveEasBuildProfileEnv({ easJsonPath, profileId: environment });

  /** @type {Record<string, string>} */
  const resolved = { ...easProfileEnv };

  const appConfig = resolveMobileAppEnvironmentConfig(environment);
  const identityDefaults = {
    EXPO_APP_NAME: pickNonEmptyString(appConfig.name),
    EXPO_APP_BUNDLE_ID: pickNonEmptyString(appConfig.iosBundleId),
    EXPO_ANDROID_PACKAGE: pickNonEmptyString(appConfig.androidPackage),
    EXPO_APP_SCHEME: pickNonEmptyString(appConfig.scheme),
  };

  for (const key of OTA_IDENTITY_ENV_KEYS) {
    if (pickNonEmptyString(resolved[key])) continue;
    resolved[key] = identityDefaults[key];
  }

  for (const key of Object.keys(resolved)) {
    if (!pickNonEmptyString(resolved[key])) delete resolved[key];
  }

  return resolved;
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      message: { type: 'string', default: '' },
      'runtime-version': { type: 'string', default: '' },
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

  const uiDir = path.join(repoRoot, 'apps', 'ui');
  const appEnvironment = normalizedEnvironment;
  const updateLane = resolveMobileAppEnvironmentConfig(normalizedEnvironment).updatesChannel;
  const nodeEnvironment = resolveMobileBuildNodeEnvironment(normalizedEnvironment);
  const otaFingerprintEnv = resolveOtaFingerprintEnv(uiDir, normalizedEnvironment);
  const explicitRuntimeVersion = String(values['runtime-version'] ?? '').trim();

  /** @type {Record<string, string>} */
  const injectedEnv = { ...otaFingerprintEnv };
  if (explicitRuntimeVersion) {
    injectedEnv.HAPPIER_EXPO_RUNTIME_VERSION = explicitRuntimeVersion;
  }
  for (const [key, value] of Object.entries(injectedEnv)) {
    if (!pickNonEmptyString(value)) delete injectedEnv[key];
  }

  for (const key of Object.keys(injectedEnv)) {
    const existing = pickNonEmptyString(process.env[key]);
    if (existing) {
      delete injectedEnv[key];
    }
  }

  const easCommandEnv = withEasGitCaseSensitiveEnv(
    applyExpoNodeHeapEnv({
      ...process.env,
      APP_ENV: process.env.APP_ENV ?? appEnvironment,
      NODE_ENV: process.env.NODE_ENV ?? nodeEnvironment,
      EXPO_UPDATES_CHANNEL: process.env.EXPO_UPDATES_CHANNEL ?? updateLane,
      ...injectedEnv,
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

  const retrySettings = resolveOtaRetrySettings(process.env);
  const updateArgs = [
    '--yes',
    `eas-cli@${easCliVersion}`,
    'update',
    '--channel',
    updateLane,
    ...(interactivity.nonInteractive ? ['--non-interactive'] : []),
    '--message',
    message,
  ];

  for (let attempt = 0; attempt <= retrySettings.maxRetries; attempt += 1) {
    try {
      const stdout = run(opts, 'npx', updateArgs, {
        cwd: uiDir,
        env: easCommandEnv,
        // In non-interactive mode we can capture output and pattern-match transient failures.
        stdio: interactivity.nonInteractive ? 'pipe' : 'inherit',
      });
      if (interactivity.nonInteractive && stdout) {
        // Preserve useful CLI output when we run with stdio=pipe.
        process.stdout.write(stdout);
      }
      break;
    } catch (error) {
      if (!interactivity.nonInteractive || !isTransientEasUpdateFailure(error) || attempt >= retrySettings.maxRetries) {
        throw error;
      }

      const delayMs = retrySettings.baseDelayMs * (2 ** attempt);
      console.error(`[pipeline] eas update failed with a transient error; retrying in ${delayMs}ms (attempt ${attempt + 1}/${retrySettings.maxRetries})`);
      sleepMs(delayMs);
    }
  }

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
