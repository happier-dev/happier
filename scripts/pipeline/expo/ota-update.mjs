// @ts-check

import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { maybeUploadSentryExpoSourceMaps } from './sentry-upload-sourcemaps.mjs';
import { withEasGitCaseSensitiveEnv } from './eas-git-case-sensitive-env.mjs';
import { applyExpoNodeHeapEnv } from '../../expo/expoNodeHeapEnv.mjs';
import { normalizeInteractiveOverride, resolveExpoInteractivity } from './resolve-expo-interactivity.mjs';
import { resolveEasBuildProfileEnv } from './resolve-eas-build-profile-env.mjs';
import { createCanonicalFingerprintFromExpoFingerprint } from './canonical-fingerprint.mjs';
import { parseExpoFingerprintFromCommandOutput } from './parse-json-from-command-output.mjs';
import {
  MOBILE_RELEASE_PROFILES,
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
const EAS_CAPTURE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PREPARED_UPDATE_METADATA = 'happier-ota-prepared.json';
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

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
    maxBuffer: EAS_CAPTURE_MAX_BUFFER_BYTES,
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

function readFullGitSha(raw, name) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!FULL_GIT_SHA.test(value)) fail(`${name} must be a full 40-character Git commit SHA.`);
  return value;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listPreparedUpdateFiles(rootDir) {
  const files = [];
  const visit = (relativeDir) => {
    const absoluteDir = path.join(rootDir, relativeDir);
    for (const name of fs.readdirSync(absoluteDir).sort((a, b) => a.localeCompare(b))) {
      const relativePath = path.posix.join(relativeDir.split(path.sep).join('/'), name);
      if (relativePath === PREPARED_UPDATE_METADATA) continue;
      const absolutePath = path.join(rootDir, ...relativePath.split('/'));
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail(`Prepared OTA artifact must not contain symlinks: ${relativePath}`);
      if (stat.isDirectory()) {
        visit(relativePath);
        continue;
      }
      if (!stat.isFile()) fail(`Prepared OTA artifact contains a non-file entry: ${relativePath}`);
      files.push({ path: relativePath, size: stat.size, sha256: sha256File(absolutePath) });
    }
  };
  visit('');
  if (files.length === 0) fail('Prepared OTA artifact contains no exported update files.');
  return files;
}

function writePreparedUpdateMetadata({ inputDir, sourceSha, environment, platform, runtimeVersion, updateLane, easCliVersion }) {
  const metadata = {
    version: 1,
    sourceSha,
    environment,
    platform,
    runtimeVersion,
    updateLane,
    easCliVersion,
    files: listPreparedUpdateFiles(inputDir),
  };
  fs.writeFileSync(path.join(inputDir, PREPARED_UPDATE_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return metadata;
}

function validatePreparedUpdateMetadata({ inputDir, expectedSourceSha, environment, platform, runtimeVersion, updateLane, easCliVersion }) {
  const metadataPath = path.join(inputDir, PREPARED_UPDATE_METADATA);
  const stat = fs.lstatSync(metadataPath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Prepared OTA metadata must be a regular file: ${metadataPath}`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata?.version !== 1) fail('Unsupported prepared OTA metadata version.');
  if (metadata.sourceSha !== expectedSourceSha) fail('Prepared OTA source SHA does not match the authorized candidate.');
  if (metadata.environment !== environment) fail('Prepared OTA environment does not match the requested promotion environment.');
  if (metadata.platform !== platform) fail('Prepared OTA platform does not match the requested promotion platform.');
  if (metadata.runtimeVersion !== runtimeVersion) fail('Prepared OTA runtime version does not match the requested promotion runtime.');
  if (metadata.updateLane !== updateLane) fail('Prepared OTA update channel does not match trusted release policy.');
  if (metadata.easCliVersion !== easCliVersion) fail('Prepared OTA EAS CLI version does not match trusted release policy.');
  const actualFiles = listPreparedUpdateFiles(inputDir);
  if (JSON.stringify(metadata.files) !== JSON.stringify(actualFiles)) {
    fail('Prepared OTA artifact bytes do not match their trusted metadata manifest.');
  }
  return metadata;
}

/**
 * @param {import('./mobile-release-environments.mjs').MobileReleaseEnvironment} environment
 * @param {'ios' | 'android'} platform
 * @returns {string}
 */
function resolveOtaFingerprintProfile(environment, platform) {
  if (platform === 'ios') return environment;
  const apkProfile = `${environment}-apk`;
  return MOBILE_RELEASE_PROFILES.includes(/** @type {any} */ (apkProfile)) ? apkProfile : environment;
}

/**
 * @param {{
 *   opts: { dryRun: boolean };
 *   uiDir: string;
 *   easCliVersion: string;
 *   platform: 'ios' | 'android';
 *   profile: string;
 *   env: Record<string, string>;
 * }} params
 * @returns {string}
 */
function generateCanonicalOtaFingerprintHash({ opts, uiDir, easCliVersion, platform, profile, env }) {
  const fpJson = run(
    opts,
    'npx',
    [
      '--yes',
      `eas-cli@${easCliVersion}`,
      'fingerprint:generate',
      '--platform',
      platform,
      '--build-profile',
      profile,
      '--json',
      '--non-interactive',
    ],
    { cwd: uiDir, env, stdio: 'pipe' },
  ).trim();
  if (!fpJson) return '';
  const parsed = parseExpoFingerprintFromCommandOutput(fpJson, `eas fingerprint:generate (${platform})`);
  const canonical = createCanonicalFingerprintFromExpoFingerprint(parsed);
  const rawHash = String(parsed?.hash ?? parsed?.fingerprintHash ?? '').trim();
  if (canonical.hash && rawHash && canonical.hash !== rawHash) {
    console.log(`[pipeline] expo ota fingerprint: platform=${platform} raw=${rawHash} canonical=${canonical.hash}`);
  }
  return String(canonical.hash || rawHash).trim();
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
      phase: { type: 'string', default: 'all' },
      'input-dir': { type: 'string', default: 'dist' },
      'source-sha': { type: 'string', default: '' },
      'expected-source-sha': { type: 'string', default: '' },
      platform: { type: 'string', default: 'all' },
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
  const phase = String(values.phase ?? '').trim() || 'all';
  if (phase !== 'all' && phase !== 'prepare' && phase !== 'publish') {
    fail(`--phase must be 'all', 'prepare', or 'publish' (got: ${phase})`);
  }

  let interactiveOverride = 'auto';
  try {
    interactiveOverride = normalizeInteractiveOverride(values.interactive);
  } catch (error) {
    fail(/** @type {Error} */ (error).message);
  }

  const interactivity = resolveExpoInteractivity({ interactiveOverride });
  const expoToken = String(process.env.EXPO_TOKEN ?? '').trim();
  if (phase !== 'prepare' && interactivity.nonInteractive && !expoToken) {
    fail('EXPO_TOKEN is required for non-interactive Expo OTA updates.');
  }

  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';
  const platformRaw = String(values.platform ?? '').trim().toLowerCase() || 'all';
  if (platformRaw !== 'ios' && platformRaw !== 'android' && platformRaw !== 'all') {
    fail(`--platform must be 'ios', 'android', or 'all' (got: ${values.platform})`);
  }
  /** @type {'ios' | 'android' | 'all'} */
  const platform = platformRaw;

  console.log(`[pipeline] expo ota: environment=${formatMobileReleaseEnvironment(normalizedEnvironment)} platform=${platform}`);

  const uiDir = path.join(repoRoot, 'apps', 'ui');
  const inputDir = path.resolve(repoRoot, String(values['input-dir'] ?? '').trim() || 'dist');
  const appEnvironment = normalizedEnvironment;
  const updateLane = resolveMobileAppEnvironmentConfig(normalizedEnvironment).updatesChannel;
  const nodeEnvironment = resolveMobileBuildNodeEnvironment(normalizedEnvironment);
  const otaFingerprintEnv = resolveOtaFingerprintEnv(uiDir, normalizedEnvironment);
  const explicitRuntimeVersion = String(values['runtime-version'] ?? '').trim();
  if (explicitRuntimeVersion && platform === 'all') {
    fail('--runtime-version requires --platform ios or --platform android so the override targets one runtime.');
  }

  /** @type {Record<string, string>} */
  const injectedEnv = { ...otaFingerprintEnv };
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
      EXPO_UNSTABLE_WEB_MODAL: '1',
    }, {
      envKey: 'HAPPIER_PIPELINE_EXPO_MAX_OLD_SPACE_SIZE_MB',
    }),
  );
  const runtimeVersion =
    explicitRuntimeVersion ||
    (normalizedEnvironment === 'publicdev' && platform !== 'all'
      ? generateCanonicalOtaFingerprintHash({
          opts,
          uiDir,
          easCliVersion,
          platform,
          profile: resolveOtaFingerprintProfile(normalizedEnvironment, platform),
          env: easCommandEnv,
        })
      : '');
  if (runtimeVersion) {
    easCommandEnv.HAPPIER_EXPO_RUNTIME_VERSION = runtimeVersion;
  }

  const sourceShaInput = String(values['source-sha'] ?? '').trim();
  const expectedSourceShaInput = String(values['expected-source-sha'] ?? '').trim();
  let preparedSourceSha = '';
  if (phase !== 'publish') {
    if (phase === 'prepare') {
      const checkedOutSha = readFullGitSha(execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(), 'candidate HEAD');
      preparedSourceSha = sourceShaInput ? readFullGitSha(sourceShaInput, '--source-sha') : checkedOutSha;
      if (preparedSourceSha !== checkedOutSha) fail('Prepared OTA source SHA does not match the checked-out candidate.');
    }

    const candidateEnv = { ...easCommandEnv, EXPO_TOKEN: '' };
    run(opts, 'yarn', ['tsx', 'sources/scripts/parseChangelog.ts'], { cwd: uiDir, env: candidateEnv });
    run(opts, 'yarn', ['tsx', 'sources/scripts/parseReleaseNotes.ts'], { cwd: uiDir, env: candidateEnv });
    run(opts, 'yarn', ['typecheck'], { cwd: uiDir, env: candidateEnv });
    run(opts, 'yarn', ['expo', 'export', '--platform', platform, '--output-dir', inputDir], {
      cwd: uiDir,
      env: candidateEnv,
    });
    if (!dryRun && phase === 'prepare') {
      writePreparedUpdateMetadata({
        inputDir,
        sourceSha: preparedSourceSha,
        environment: normalizedEnvironment,
        platform,
        runtimeVersion,
        updateLane,
        easCliVersion,
      });
    }
    if (phase === 'prepare') return;
  }

  const expectedSourceSha = phase === 'publish'
    ? readFullGitSha(expectedSourceShaInput, '--expected-source-sha')
    : preparedSourceSha;
  if (!dryRun && phase === 'publish') {
    validatePreparedUpdateMetadata({
      inputDir,
      expectedSourceSha,
      environment: normalizedEnvironment,
      platform,
      runtimeVersion,
      updateLane,
      easCliVersion,
    });
  }

  const message = resolvePreviewMessage(normalizedEnvironment, values.message, opts);
  if (!message) fail(`Missing Expo update message for ${normalizedEnvironment} OTA update.`);

  const retrySettings = resolveOtaRetrySettings(process.env);
  const updateArgs = [
    '--yes',
    `eas-cli@${easCliVersion}`,
    'update',
    '--channel',
    updateLane,
    ...(platform !== 'all' ? ['--platform', platform] : []),
    ...(interactivity.nonInteractive ? ['--non-interactive'] : []),
    '--message',
    message,
    '--skip-bundler',
    '--input-dir',
    inputDir,
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
    distDir: inputDir,
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
