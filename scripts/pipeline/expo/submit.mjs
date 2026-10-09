// @ts-check

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { ensureAscApiKeyFile } from './ensure-asc-api-key-file.mjs';
import { readIosIpaMetadata } from './read-ios-ipa-metadata.mjs';
import { normalizeInteractiveOverride, resolveExpoInteractivity } from './resolve-expo-interactivity.mjs';
import { publishGooglePlayProduction, requireGooglePlayCredential, requireGooglePlayVersionCode } from './google-play-publish.mjs';
import { readBoundStoreNotes } from '../release/release-notes/project-release-notes.mjs';
import { readAndroidAabMetadata } from './read-android-aab-metadata.mjs';
import { verifyAndroidPageSize } from './verify-android-page-size.mjs';
import { parseEasJsonCommandOutput } from './parse-eas-json-command-output.mjs';
import {
  allowsBestEffortSubmit,
  MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES,
  formatMobileReleaseEnvironment,
  normalizeMobileReleaseEnvironment,
  normalizeMobileReleaseProfile,
  resolveMobileAppEnvironmentConfig,
  supportsMobileNativeSubmit,
} from './mobile-release-environments.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const ANDROID_RELEASE_STATUS_CHOICES = ['profile', 'completed', 'draft', 'halted', 'inProgress'];

/**
 * @param {unknown} value
 */
function normalizeAndroidReleaseStatus(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'draft';
  const normalized = raw.toLowerCase();
  if (normalized === 'inprogress' || normalized === 'in-progress' || normalized === 'in_progress') return 'inProgress';
  const exact = ANDROID_RELEASE_STATUS_CHOICES.find((choice) => choice.toLowerCase() === normalized);
  if (exact) return exact;
  fail(`--android-release-status must be one of: ${ANDROID_RELEASE_STATUS_CHOICES.join(', ')} (got: ${raw})`);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * Resolves the expected iOS bundle identifier for the requested environment.
 *
 * @param {{ environment: import('./mobile-release-environments.mjs').MobileReleaseEnvironment; env: Record<string, string> }} opts
 * @returns {{ bundleIdentifier: string; source: string }}
 */
function resolveExpectedIosBundleId(opts) {
  const override = String(opts.env.EXPO_APP_BUNDLE_ID ?? opts.env.HAPPY_STACKS_IOS_BUNDLE_ID ?? '').trim();
  if (override) return { bundleIdentifier: override, source: 'env override' };
  return {
    bundleIdentifier: resolveMobileAppEnvironmentConfig(opts.environment).iosBundleId,
    source: 'apps/ui/appVariantConfig.cjs',
  };
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string>; allowFailure?: boolean; timeoutMs?: number }} [extra]
 * @returns {{ ok: boolean; output: string }}
 */
function run(opts, cmd, args, extra) {
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return { ok: true, output: '' };
  }

  try {
    const out = execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, ...(extra?.env ?? {}) },
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: extra?.timeoutMs ?? 30 * 60_000,
    });
    return { ok: true, output: String(out ?? '') };
  } catch (err) {
    if (extra?.allowFailure) return { ok: false, output: '' };
    throw err;
  }
}

/**
 * @param {string} filePath
 * @param {string} content
 */
function writeTextFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const tmpPath = path.join(dir, `.${basename}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Ensures EAS submit can run non-interactively for iOS by creating the ASC API key file referenced by `apps/ui/eas.json`.
 *
 * @param {{ repoRoot: string; uiDir: string; submitProfile: string; dryRun: boolean }} opts
 */
function ensureIosSubmitAscApiKeyFile(opts) {
  const easPath = path.join(opts.uiDir, 'eas.json');
  if (!fs.existsSync(easPath)) {
    fail(`Missing apps/ui/eas.json at: ${easPath}`);
  }

  /** @type {any} */
  const easJson = JSON.parse(fs.readFileSync(easPath, 'utf8'));
  const iosSubmit = easJson?.submit?.[opts.submitProfile]?.ios ?? null;
  const ascApiKeyPath = String(iosSubmit?.ascApiKeyPath ?? '').trim();
  const ascApiKeyId = String(iosSubmit?.ascApiKeyId ?? '').trim();

  if (!ascApiKeyPath || !ascApiKeyId) {
    fail(
      [
        `apps/ui/eas.json is missing submit.${opts.submitProfile}.ios.ascApiKeyPath / ascApiKeyId.`,
        'EAS cannot set up App Store Connect API keys in --non-interactive mode.',
        'Fix: add ascApiKeyId, ascApiKeyIssuerId, and ascApiKeyPath in apps/ui/eas.json, and provide APPLE_API_PRIVATE_KEY to the pipeline.',
      ].join('\n'),
    );
  }

  const expectedRel = `./.eas/keys/AuthKey_${ascApiKeyId}.p8`;
  if (ascApiKeyPath !== expectedRel) {
    fail(
      [
        `Unsupported submit.${opts.submitProfile}.ios.ascApiKeyPath in apps/ui/eas.json (got: ${JSON.stringify(ascApiKeyPath)}).`,
        `Expected: ${JSON.stringify(expectedRel)}`,
      ].join('\n'),
    );
  }

  const privateKey = String(process.env.APPLE_API_PRIVATE_KEY ?? '').trim();
  if (!privateKey) {
    fail(
      [
        'APPLE_API_PRIVATE_KEY is required for non-interactive iOS submit.',
        `It must contain the App Store Connect API key .p8 contents (PEM or base64-encoded PEM).`,
        '',
        `Expected to write: ${expectedRel}`,
      ].join('\n'),
    );
  }

  const outPath = ensureAscApiKeyFile({
    uiDir: opts.uiDir,
    keyId: ascApiKeyId,
    privateKey,
    dryRun: opts.dryRun,
  });

  const printable = path.relative(opts.repoRoot, outPath) || outPath;
  if (opts.dryRun) {
    console.log(`[dry-run] ensure ASC API key file at: ${printable}`);
  } else {
    console.log(`[pipeline] ensured ASC API key file at: ${printable}`);
  }
}

/**
 * Temporarily applies the Android release status to the selected EAS submit profile.
 * EAS exposes this through eas.json rather than a submit CLI flag, so the pipeline
 * patches the profile for the duration of this submit invocation and restores it.
 *
 * @param {{ repoRoot: string; uiDir: string; submitProfile: string; androidReleaseStatus: string; dryRun: boolean }} opts
 * @returns {() => void}
 */
function applyAndroidReleaseStatusOverride(opts) {
  if (opts.androidReleaseStatus === 'profile') {
    return () => {};
  }

  const easPath = path.join(opts.uiDir, 'eas.json');
  if (!fs.existsSync(easPath)) {
    fail(`Missing apps/ui/eas.json at: ${easPath}`);
  }

  const original = fs.readFileSync(easPath, 'utf8');
  /** @type {any} */
  const easJson = JSON.parse(original);
  if (!easJson.submit || typeof easJson.submit !== 'object') {
    fail('apps/ui/eas.json is missing submit profiles.');
  }
  if (!easJson.submit[opts.submitProfile] || typeof easJson.submit[opts.submitProfile] !== 'object') {
    fail(`apps/ui/eas.json is missing submit.${opts.submitProfile}.`);
  }

  const submitProfileConfig = easJson.submit[opts.submitProfile];
  if (!submitProfileConfig.android || typeof submitProfileConfig.android !== 'object') {
    submitProfileConfig.android = {};
  }
  const androidSubmit = submitProfileConfig.android;
  const androidReleaseStatus = opts.androidReleaseStatus;
  androidSubmit.releaseStatus = androidReleaseStatus;
  const next = `${JSON.stringify(easJson, null, 2)}\n`;
  const printablePath = path.relative(opts.repoRoot, easPath) || easPath;

  if (opts.dryRun) {
    console.log(`[dry-run] set ${printablePath} submit.${opts.submitProfile}.android.releaseStatus=${opts.androidReleaseStatus}`);
    return () => {};
  }

  writeTextFileAtomic(easPath, next);
  console.log(`[pipeline] set Android EAS submit releaseStatus=${opts.androidReleaseStatus} for profile '${opts.submitProfile}'`);

  return () => {
    writeTextFileAtomic(easPath, original);
  };
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      platform: { type: 'string' },
      id: { type: 'string', default: '' },
      path: { type: 'string', default: '' },
      profile: { type: 'string', default: '' },
      'project-dir': { type: 'string', default: '' },
      interactive: { type: 'string', default: 'auto' },
      'eas-cli-version': { type: 'string', default: '' },
      'android-release-status': { type: 'string', default: 'draft' },
      'release-notes-json': { type: 'string', default: '' },
      'source-sha': { type: 'string', default: '' },
      'release-id': { type: 'string', default: '' },
      'app-version': { type: 'string', default: '' },
      'android-version-code': { type: 'string', default: '' },
      wait: { type: 'string', default: 'true' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const requestedEnvironment = String(values.environment ?? '').trim();
  const environment = normalizeMobileReleaseEnvironment(requestedEnvironment);
  if (!environment || !supportsMobileNativeSubmit(environment)) {
    fail(`--environment must be ${JSON.stringify(MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES)} (got: ${requestedEnvironment || '<empty>'})`);
  }

  const platformRaw = String(values.platform ?? '').trim();
  if (!platformRaw) fail('--platform is required');
  if (platformRaw !== 'ios' && platformRaw !== 'android' && platformRaw !== 'all') {
    fail(`--platform must be 'ios', 'android', or 'all' (got: ${platformRaw})`);
  }

  const submitIdRaw = String(values.id ?? '').trim();
  const submitPathRaw = String(values.path ?? '').trim();
  const requestedProfile = String(values.profile ?? '').trim();
  const submitProfile = normalizeMobileReleaseProfile(requestedProfile) || requestedProfile || environment;
  if (submitPathRaw && platformRaw === 'all') {
    fail("--platform 'all' cannot be used with --path (submit per-platform with explicit paths).");
  }
  if (submitIdRaw && submitPathRaw) {
    fail('Pass only one of --id or --path (not both).');
  }
  if (submitIdRaw && platformRaw === 'all') {
    fail("--platform 'all' cannot be used with --id (submit per-platform with explicit ids).");
  }

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  let interactiveOverride = 'auto';
  try {
    interactiveOverride = normalizeInteractiveOverride(values.interactive);
  } catch (error) {
    fail(/** @type {Error} */ (error).message);
  }

  const { isCi, nonInteractive } = resolveExpoInteractivity({ interactiveOverride });

  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';
  const waitForSubmit = parseBool(values.wait, '--wait');
  const androidReleaseStatus = normalizeAndroidReleaseStatus(values['android-release-status']);

  const platforms = platformRaw === 'all' ? ['ios', 'android'] : [platformRaw];
  const productionAndroid = environment === 'production' && platforms.includes('android');
  let playPublication;
  if (productionAndroid) {
    // Preflight before either platform uploads: publication must not silently stop at draft.
    requireGooglePlayCredential(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    if (!waitForSubmit) fail('Production Android publication requires --wait true so the exact uploaded version can be completed with its notes.');
    if (!submitIdRaw && !submitPathRaw) fail('Production Android publication requires an exact --id build or --path artifact; --latest is not bound to approved notes.');
    const whatsNew = readBoundStoreNotes({
      bundlePath: path.resolve(repoRoot, String(values['release-notes-json'] || '')),
      sourceSha: String(values['source-sha']), releaseId: String(values['release-id']),
      appVersion: String(values['app-version']), platform: 'android',
    });
    playPublication = {
      packageName: resolveMobileAppEnvironmentConfig(environment).androidPackage,
      versionCode: '', whatsNew, credentialJson: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
    };
  }
  console.log(`[pipeline] expo submit: environment=${formatMobileReleaseEnvironment(environment)} platform=${platformRaw}`);

  const projectDirRaw = String(values['project-dir'] ?? '').trim();
  const uiDir = projectDirRaw ? path.resolve(repoRoot, projectDirRaw) : path.join(repoRoot, 'apps', 'ui');
  if (!fs.existsSync(uiDir)) fail(`Expo submit project directory does not exist: ${uiDir}`);
  if (productionAndroid) {
    const easConfig = JSON.parse(fs.readFileSync(path.join(uiDir, 'eas.json'), 'utf8'));
    if (easConfig?.submit?.[submitProfile]?.android?.track !== 'production') {
      fail('Production Android publication requires a submit profile targeting the production track.');
    }
  }
  const submitPathAbs = submitPathRaw ? path.resolve(repoRoot, submitPathRaw) : '';
  if (submitPathAbs) {
    if (!fs.existsSync(submitPathAbs)) {
      if (dryRun) {
        console.log(`[dry-run] submit artifact not present yet, skipping local artifact validation: ${submitPathAbs}`);
      } else {
      fail(
        [
          `${submitPathAbs} doesn't exist`,
          '',
          'Tip: local production builds are versioned.',
          'Example iOS: dist/ui-mobile/happier-production-ios-v<uiVersion>.ipa',
          'Example Android (AAB): dist/ui-mobile/happier-production-android-v<uiVersion>.aab',
          '',
          'Run: ls dist/ui-mobile',
        ].join('\n'),
      );
      }
    } else if (platforms.includes('ios')) {
      const meta = readIosIpaMetadata({ ipaPath: submitPathAbs, env: process.env });
      if (meta?.bundleIdentifier) {
        const expected = resolveExpectedIosBundleId({ environment, env: process.env });
        if (expected.bundleIdentifier && meta.bundleIdentifier !== expected.bundleIdentifier) {
          fail(
            [
              `iOS archive bundle identifier mismatch for environment='${environment}'.`,
              `Display environment:              ${formatMobileReleaseEnvironment(environment)}`,
              '',
              `Expected (${expected.source}): ${expected.bundleIdentifier}`,
              `Actual (archive):               ${meta.bundleIdentifier}${meta.displayName ? ` (${meta.displayName})` : ''}`,
              meta.version || meta.buildNumber
                ? `Archive version/build:         ${meta.version || '?'} (${meta.buildNumber || '?'})`
                : '',
              '',
              'Fix: rebuild the iOS archive with the correct EAS build profile for the requested environment, then re-run expo-submit.',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }
      }
    }
  }

  const expoToken = String(process.env.EXPO_TOKEN ?? '').trim();
  // CI releases should require explicit Expo auth for cloud submissions, but allow dry-run validation
  // of local artifacts (contract tests) without requiring an EXPO_TOKEN.
  if (isCi && !expoToken && !(dryRun && submitPathAbs)) {
    fail('EXPO_TOKEN is required for Expo submit.');
  }

  let androidMetadata;
  let androidSubmitId = submitIdRaw;
  const verifyAndroidSubmission = async () => {
    const appEnvOverride = String(process.env.HAPPIER_EXPO_SUBMIT_APP_ENV ?? '').trim();
    if (productionAndroid && appEnvOverride && appEnvOverride !== 'production') throw new Error('Production Android publication cannot use another APP_ENV.');
    const appEnv = appEnvOverride || formatMobileReleaseEnvironment(environment);
    if (dryRun && (!submitPathAbs || !fs.existsSync(submitPathAbs))) {
      console.log('[dry-run] verify Android 16KB page size, package, app version, versionCode, and exact EAS source/profile against the submitted AAB before upload');
      androidMetadata = {
        packageName: playPublication?.packageName, appVersion: values['app-version'],
        versionCode: values['android-version-code'] || '<from-exact-artifact>',
      };
    } else if (submitPathAbs) {
      if (!submitPathAbs.endsWith('.aab')) throw new Error('Android store submission requires an AAB artifact.');
      verifyAndroidPageSize({ aabPath: submitPathAbs });
      androidMetadata = readAndroidAabMetadata({ aabPath: submitPathAbs });
    } else {
      // Resolve a legacy nonproduction --latest once, then verify and submit the
      // same immutable ID. Production already requires an explicit artifact/ID.
      if (!androidSubmitId) {
        // Match eas-cli 18.0.1 submit/utils/builds.ts eligibility, including a
        // newer pending build rather than silently uploading an older one.
        const builds = ['new', 'in-queue', 'in-progress', 'finished'].flatMap((status) => {
          const output = execFileSync('npx', ['--yes', `eas-cli@${easCliVersion}`, 'build:list', '--platform', 'android', '--distribution', 'store', '--status', status, '--limit', '1', '--json', '--non-interactive'], {
            cwd: uiDir, env: { ...process.env, APP_ENV: appEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          });
          const parsed = parseEasJsonCommandOutput(output, 'eas build:list');
          if (!Array.isArray(parsed)) throw new Error('Invalid Android EAS build list.');
          return parsed;
        }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        androidSubmitId = typeof builds[0]?.id === 'string' ? builds[0].id : '';
        if (!androidSubmitId) throw new Error('No Android store EAS build is available to verify before submission.');
      }
      const output = execFileSync('npx', ['--yes', `eas-cli@${easCliVersion}`, 'build:view', androidSubmitId, '--json'], {
        cwd: uiDir, env: { ...process.env, APP_ENV: appEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const build = parseEasJsonCommandOutput(output, 'eas build:view');
      if (build?.id !== androidSubmitId || String(build?.platform).toLowerCase() !== 'android' || build?.status !== 'FINISHED') {
        throw new Error('The selected EAS Android build must finish before page-size verification and upload; retry with its exact --id after completion.');
      }
      if (productionAndroid && (build?.gitCommitHash !== values['source-sha'] || build?.buildProfile !== submitProfile)) {
        throw new Error('The exact EAS Android build must match the approved source SHA, profile, and finished build identity.');
      }
      const archiveUrl = build?.artifacts?.applicationArchiveUrl ?? build?.artifacts?.buildUrl;
      if (typeof archiveUrl !== 'string' || !archiveUrl.startsWith('https://')) throw new Error('Exact EAS build has no downloadable HTTPS Android archive.');
      const response = await fetch(archiveUrl);
      if (!response.ok) throw new Error(`Unable to read the exact EAS Android archive (HTTP ${response.status}).`);
      const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-android-submit-'));
      const archivePath = path.join(temporaryDir, 'build.aab');
      try {
        fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
        verifyAndroidPageSize({ aabPath: archivePath });
        androidMetadata = readAndroidAabMetadata({ aabPath: archivePath });
      } finally {
        fs.rmSync(temporaryDir, { recursive: true, force: true });
      }
      if (androidMetadata.appVersion !== build.appVersion || androidMetadata.versionCode !== String(build.appBuildVersion ?? '')) {
        throw new Error('Exact EAS build version does not match its Android archive.');
      }
    }
  };
  if (productionAndroid) await verifyAndroidSubmission();

  if (playPublication) {
    const metadata = androidMetadata;
    if (metadata.packageName !== playPublication.packageName || metadata.appVersion !== values['app-version']) {
      fail('Android artifact package/app version does not match the production target and bound release notes.');
    }
    playPublication.versionCode = dryRun && metadata.versionCode === '<from-exact-artifact>'
      ? metadata.versionCode : requireGooglePlayVersionCode(metadata.versionCode);
    if (values['android-version-code'] && values['android-version-code'] !== playPublication.versionCode) {
      fail('Requested Android versionCode does not match the exact submitted artifact.');
    }
  }

  if (platforms.includes('ios') && nonInteractive) {
    ensureIosSubmitAscApiKeyFile({ repoRoot, uiDir, submitProfile, dryRun });
  }

  const restoreAndroidReleaseStatus =
    platforms.includes('android')
      ? applyAndroidReleaseStatusOverride({
          repoRoot,
          uiDir,
          submitProfile,
          // Play commits approved notes and completed together, after EAS has uploaded a draft.
          androidReleaseStatus: productionAndroid ? 'draft' : androidReleaseStatus,
          dryRun,
        })
      : () => {};

  let hadFailure = false;
  try {
    for (const platform of platforms) {
      if (platform === 'android' && !productionAndroid) {
        try { await verifyAndroidSubmission(); }
        catch (error) {
          if (!allowsBestEffortSubmit(environment)) throw error;
          hadFailure = true;
          console.error(error instanceof Error ? error.message : String(error));
          console.log(`::warning::Expo submit failed for android in ${formatMobileReleaseEnvironment(environment)}; artifact verification refused upload.`);
          continue;
        }
      }
      const baseArgs = ['--yes', `eas-cli@${easCliVersion}`, 'submit', '--platform', platform, '--profile', submitProfile];
      const platformSubmitId = platform === 'android' ? androidSubmitId : submitIdRaw;
      const submitArgs = platformSubmitId
        ? [...baseArgs, '--id', platformSubmitId]
        : submitPathAbs
          ? [...baseArgs, '--path', submitPathAbs]
          : [...baseArgs, '--latest'];
      if (nonInteractive) submitArgs.push('--non-interactive');
      submitArgs.push(waitForSubmit ? '--wait' : '--no-wait');

      // CI workflows often set a repo-global APP_ENV (for example preview). For submit we must default
      // to the requested pipeline environment, otherwise we can end up submitting a mismatched variant.
      const appEnvOverride = String(process.env.HAPPIER_EXPO_SUBMIT_APP_ENV ?? '').trim();
      const appEnv = appEnvOverride || formatMobileReleaseEnvironment(environment);
      const result = run(opts, 'npx', submitArgs, {
        cwd: uiDir,
        env: {
          // apps/ui/app.config.js selects bundle ids by APP_ENV; ensure submit uses the same variant
          // as the intended pipeline environment unless the operator overrides it explicitly.
          APP_ENV: appEnv,
        },
        allowFailure: allowsBestEffortSubmit(environment),
      });
      if (!result.ok) {
        hadFailure = true;
        console.log(`::warning::Expo submit failed for ${platform} in ${formatMobileReleaseEnvironment(environment)}; continuing so successful platform submissions are preserved.`);
      }
      if (platform === 'android' && playPublication && result.ok) {
        if (dryRun) {
          console.log(`[dry-run] Google Play production publication: package=${playPublication.packageName} versionCode=${playPublication.versionCode} releaseStatus=completed (approved notes bound; public availability unverified)`);
        } else {
          console.log(JSON.stringify(await publishGooglePlayProduction(playPublication)));
        }
      }
    }
  } finally {
    restoreAndroidReleaseStatus();
  }

  if (hadFailure) {
    console.error(
      `::error::One or more Expo submissions failed for ${formatMobileReleaseEnvironment(environment)} after all requested platforms were attempted.`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'publication_failed', code: error.code ?? 'submit_failed', message: error.message, httpStatus: error.httpStatus, operation: error.operation, apiStatus: error.apiStatus, apiMessage: error.apiMessage, apiReasons: error.apiReasons }));
  process.exitCode = 1;
});
