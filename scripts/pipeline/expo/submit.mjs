// @ts-check

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { ensureAscApiKeyFile } from './ensure-asc-api-key-file.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
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

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      platform: { type: 'string' },
      path: { type: 'string', default: '' },
      profile: { type: 'string', default: '' },
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

  const platformRaw = String(values.platform ?? '').trim();
  if (!platformRaw) fail('--platform is required');
  if (platformRaw !== 'ios' && platformRaw !== 'android' && platformRaw !== 'all') {
    fail(`--platform must be 'ios', 'android', or 'all' (got: ${platformRaw})`);
  }

  const submitPathRaw = String(values.path ?? '').trim();
  const submitProfile = String(values.profile ?? '').trim() || environment;
  if (submitPathRaw && platformRaw === 'all') {
    fail("--platform 'all' cannot be used with --path (submit per-platform with explicit paths).");
  }

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const isCi = String(process.env.CI ?? '').trim().toLowerCase() === 'true' || String(process.env.GITHUB_ACTIONS ?? '').trim() === 'true';
  const expoToken = String(process.env.EXPO_TOKEN ?? '').trim();
  if (isCi && !expoToken) {
    fail('EXPO_TOKEN is required for Expo submit.');
  }
  const pipelineInteractive =
    String(process.env.PIPELINE_INTERACTIVE ?? '').trim() === '1' ||
    String(process.env.PIPELINE_INTERACTIVE ?? '').trim().toLowerCase() === 'true';
  // Default to non-interactive when EXPO_TOKEN is present (matches CI behavior), but allow an explicit
  // local escape hatch for one-time credential bootstrap (e.g. Google Play service account setup).
  const nonInteractive = isCi || (Boolean(expoToken) && !pipelineInteractive);

  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';

  const platforms = platformRaw === 'all' ? ['ios', 'android'] : [platformRaw];
  console.log(`[pipeline] expo submit: environment=${environment} platform=${platformRaw}`);

  const uiDir = path.join(repoRoot, 'apps', 'ui');
  const submitPathAbs = submitPathRaw ? path.resolve(repoRoot, submitPathRaw) : '';
  if (submitPathAbs && !dryRun) {
    // Avoid importing fs for this script; let EAS fail with a clear message if the path is invalid.
  }

  if (platforms.includes('ios') && nonInteractive) {
    ensureIosSubmitAscApiKeyFile({ repoRoot, uiDir, submitProfile, dryRun });
  }

  let hadFailure = false;
  for (const platform of platforms) {
    const baseArgs = ['--yes', `eas-cli@${easCliVersion}`, 'submit', '--platform', platform, '--profile', submitProfile];
    const submitArgs = submitPathAbs ? [...baseArgs, '--path', submitPathAbs] : [...baseArgs, '--latest'];
    if (nonInteractive) submitArgs.push('--non-interactive');

    const appEnv = String(process.env.APP_ENV ?? '').trim() || environment;
    const result = run(opts, 'npx', submitArgs, {
      cwd: uiDir,
      env: {
        // apps/ui/app.config.js selects bundle ids by APP_ENV; ensure submit uses the same variant
        // as the intended pipeline environment unless the operator overrides it explicitly.
        APP_ENV: appEnv,
      },
      allowFailure: environment === 'preview',
    });
    if (!result.ok) {
      hadFailure = true;
      console.log(`::warning::Expo submit failed for ${platform} in preview; continuing so successful platform submissions are preserved.`);
    }
  }

  if (hadFailure) {
    process.exitCode = 0;
  }
}

main();
