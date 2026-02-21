// @ts-check

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { ensureAscApiKeyFile } from './ensure-asc-api-key-file.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} cmd
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function commandExists(cmd, env) {
  try {
    execFileSync('bash', ['-lc', `command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`], {
      env,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} key
 * @param {string} xml
 * @returns {string}
 */
function readPlistXmlStringValue(key, xml) {
  const re = new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]*)<\\/string>`, 'm');
  const m = xml.match(re);
  return m ? String(m[1] ?? '').trim() : '';
}

/**
 * @param {string} zipPath
 * @param {Record<string, string>} env
 * @returns {string[]}
 */
function listZipEntries(zipPath, env) {
  const out = execFileSync('unzip', ['-Z1', zipPath], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return String(out ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * @param {string} zipPath
 * @param {string} entry
 * @param {Record<string, string>} env
 * @returns {Buffer}
 */
function extractZipEntry(zipPath, entry, env) {
  const out = execFileSync('unzip', ['-p', zipPath, entry], {
    env,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return Buffer.isBuffer(out) ? out : Buffer.from(out ?? '');
}

/**
 * Resolves the expected iOS bundle identifier for the requested environment.
 *
 * We intentionally avoid executing `apps/ui/app.config.js` here because it mixes ESM exports with `require(...)`
 * calls that are evaluated by Expo tooling, not by plain Node. Instead, we treat it as a configuration source and
 * extract the stable bundle ids from the file.
 *
 * @param {{ repoRoot: string; environment: 'preview' | 'production'; env: Record<string, string> }} opts
 * @returns {{ bundleIdentifier: string; source: string }}
 */
function resolveExpectedIosBundleId(opts) {
  const override = String(opts.env.EXPO_APP_BUNDLE_ID ?? opts.env.HAPPY_STACKS_IOS_BUNDLE_ID ?? '').trim();
  if (override) return { bundleIdentifier: override, source: 'env override' };

  const configPath = path.join(opts.repoRoot, 'apps', 'ui', 'app.config.js');
  if (!fs.existsSync(configPath)) return { bundleIdentifier: '', source: 'missing config' };
  const raw = fs.readFileSync(configPath, 'utf8');

  const prodMatch = raw.match(/iosBundleId:\s*"([^"]+)"/);
  const prod = String(prodMatch?.[1] ?? '').trim();

  const previewMatch = raw.match(/bundleIdsByVariant\s*=\s*\{[\s\S]*?\bpreview:\s*"([^"]+)"/m);
  const preview = String(previewMatch?.[1] ?? '').trim();

  const bundleIdentifier = opts.environment === 'production' ? prod : preview;
  return { bundleIdentifier, source: 'apps/ui/app.config.js' };
}

/**
 * @param {{ ipaPath: string; env: Record<string, string> }} opts
 * @returns {{ bundleIdentifier: string; displayName: string; buildNumber: string; version: string } | null}
 */
function readIosIpaMetadata(opts) {
  if (!opts.ipaPath.endsWith('.ipa')) return null;
  if (!fs.existsSync(opts.ipaPath)) return null;
  if (!commandExists('unzip', opts.env)) return null;

  const entries = listZipEntries(opts.ipaPath, opts.env);
  const infoEntry = entries.find((e) => /^Payload\/.+\.app\/Info\.plist$/.test(e));
  if (!infoEntry) return null;

  const plistBuf = extractZipEntry(opts.ipaPath, infoEntry, opts.env);
  if (!plistBuf || plistBuf.length === 0) return null;

  // Prefer plutil (handles binary plists from real IPAs). Fall back to XML parsing for simple test artifacts.
  if (commandExists('plutil', opts.env)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ipa-info-'));
    const plistPath = path.join(dir, 'Info.plist');
    fs.writeFileSync(plistPath, plistBuf);

    const readKey = (key) => {
      try {
        return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
          env: opts.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        }).trim();
      } catch {
        return '';
      }
    };

    return {
      bundleIdentifier: readKey('CFBundleIdentifier'),
      displayName: readKey('CFBundleDisplayName') || readKey('CFBundleName'),
      version: readKey('CFBundleShortVersionString'),
      buildNumber: readKey('CFBundleVersion'),
    };
  }

  const asText = plistBuf.toString('utf8');
  if (!asText.includes('<plist') || !asText.includes('CFBundleIdentifier')) return null;
  return {
    bundleIdentifier: readPlistXmlStringValue('CFBundleIdentifier', asText),
    displayName:
      readPlistXmlStringValue('CFBundleDisplayName', asText) || readPlistXmlStringValue('CFBundleName', asText),
    version: readPlistXmlStringValue('CFBundleShortVersionString', asText),
    buildNumber: readPlistXmlStringValue('CFBundleVersion', asText),
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
  if (submitPathAbs) {
    if (!fs.existsSync(submitPathAbs)) {
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

    if (platforms.includes('ios')) {
      const meta = readIosIpaMetadata({ ipaPath: submitPathAbs, env: process.env });
      if (meta?.bundleIdentifier) {
        const expected = resolveExpectedIosBundleId({ repoRoot, environment, env: process.env });
        if (expected.bundleIdentifier && meta.bundleIdentifier !== expected.bundleIdentifier) {
          fail(
            [
              `iOS archive bundle identifier mismatch for environment='${environment}'.`,
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
