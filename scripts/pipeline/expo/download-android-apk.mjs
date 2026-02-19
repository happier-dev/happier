// @ts-check

import fs from 'node:fs';
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
 * @param {{ cwd?: string; stdio?: 'inherit' | 'pipe'; timeoutMs?: number; allowFailure?: boolean }} [extra]
 * @returns {string}
 */
function run(opts, cmd, args, extra) {
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return '';
  }

  try {
    return execFileSync(cmd, args, {
      cwd,
      env: process.env,
      encoding: 'utf8',
      stdio: extra?.stdio ?? 'inherit',
      timeout: extra?.timeoutMs ?? 30 * 60_000,
    });
  } catch (err) {
    if (extra?.allowFailure) return '';
    throw err;
  }
}

/**
 * @param {string} outputPath
 * @param {Record<string, string>} values
 */
function writeGithubOutput(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v ?? '')}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {any} build
 */
function getBuildId(build) {
  const id = build?.id ?? build?.buildId ?? null;
  return id ? String(id) : '';
}

/**
 * @param {any} build
 */
function getAndroidArtifactUrlFromBuild(build) {
  const artifacts = build?.artifacts ?? {};
  const url =
    artifacts?.applicationArchiveUrl ||
    artifacts?.buildUrl ||
    artifacts?.url ||
    build?.artifactUrl ||
    build?.applicationArchiveUrl ||
    '';
  return String(url ?? '').trim();
}

/**
 * @param {string} easCliVersion
 * @param {string} buildId
 * @param {{ dryRun: boolean }} opts
 * @param {string} uiDir
 */
function resolveArtifactUrlViaBuildView(easCliVersion, buildId, opts, uiDir) {
  const viewJson = run(
    opts,
    'npx',
    ['--yes', `eas-cli@${easCliVersion}`, 'build:view', buildId, '--json'],
    { cwd: uiDir, stdio: 'pipe', timeoutMs: 5 * 60_000 },
  ).trim();
  if (!viewJson) return '';
  const parsed = JSON.parse(viewJson);
  const build = Array.isArray(parsed) ? parsed[0] : parsed;
  return getAndroidArtifactUrlFromBuild(build);
}

/**
 * @param {string} url
 */
function assertHttpsUrl(url) {
  if (!url) fail('Unable to resolve Android artifact URL from EAS output.');
  if (!url.startsWith('https://')) fail(`Resolved Android artifact URL is not https: ${url}`);
}

/**
 * @param {string} url
 * @param {string} outPath
 * @param {{ dryRun: boolean }} opts
 */
async function downloadWithRetries(url, outPath, opts) {
  if (opts.dryRun) {
    console.log(`[dry-run] would download ${url} -> ${outPath}`);
    return;
  }

  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) {
        throw new Error(`Non-2xx response: ${resp.status}`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`APK download attempt ${attempt}/${attempts} failed; retrying...`);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

/**
 * @param {string} apkPath
 * @param {{ dryRun: boolean }} opts
 */
function validateApk(apkPath, opts) {
  if (opts.dryRun) return;
  if (!fs.existsSync(apkPath)) fail(`APK download failed; expected file at: ${apkPath}`);
  const size = fs.statSync(apkPath).size;
  if (size < 1_000_000) fail(`Downloaded APK is unexpectedly small (${size} bytes): ${apkPath}`);

  // Best-effort ZIP integrity check.
  try {
    run(opts, 'unzip', ['-tq', apkPath], { stdio: 'pipe', timeoutMs: 60_000, allowFailure: false });
  } catch {
    console.log('::warning::Downloaded APK failed ZIP integrity check (unzip -tq).');
    fail(`Downloaded APK archive failed ZIP integrity check: ${apkPath}`);
  }
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'build-json': { type: 'string', default: '/tmp/eas_build.json' },
      'eas-cli-version': { type: 'string', default: '' },
      'out-dir': { type: 'string', default: 'dist/ui-mobile' },
      'github-output': { type: 'string', default: '' },
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
  if (!expoToken) fail('EXPO_TOKEN is required for Expo actions.');

  const buildJsonPath = path.resolve(String(values['build-json'] ?? '').trim());
  if (!buildJsonPath) fail('--build-json is required');
  const buildJsonExists = fs.existsSync(buildJsonPath);
  if (!buildJsonExists && !dryRun) {
    fail(`Missing EAS build json file at ${buildJsonPath}`);
  }

  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';

  const outDirRel = String(values['out-dir'] ?? '').trim() || 'dist/ui-mobile';
  const outDirAbs = path.resolve(repoRoot, outDirRel);
  const githubOutput = String(values['github-output'] ?? '').trim();

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'package.json'), 'utf8'));
  const appVersion = String(pkg.version ?? '').trim();
  if (!appVersion) fail('Unable to resolve app version from apps/ui/package.json');

  console.log(`[pipeline] expo download apk: environment=${environment}`);

  let artifactUrl = '';
  const shouldParseBuildJson = buildJsonExists && !dryRun;
  if (!shouldParseBuildJson) {
    if (!buildJsonExists) {
      console.log('::notice::Missing EAS build json file in dry-run; skipping artifact URL resolution.');
    } else {
      console.log('::notice::Skipping EAS build json parsing in dry-run; using placeholder artifact URL.');
    }
    artifactUrl = 'https://example.invalid/happier-preview-android.apk';
  } else {
    /** @type {any[]} */
    const builds = JSON.parse(fs.readFileSync(buildJsonPath, 'utf8'));
    const normalized = Array.isArray(builds) ? builds : [builds];
    const android = normalized.find((b) => String(b?.platform ?? '').toLowerCase() === 'android') ?? null;
    if (!android) fail('No Android build found in EAS output');

    const buildId = getBuildId(android);
    if (!buildId) fail('No build id found in EAS output for android');

    artifactUrl = getAndroidArtifactUrlFromBuild(android);
    const uiDir = path.join(repoRoot, 'apps', 'ui');
    if (!artifactUrl) {
      artifactUrl = resolveArtifactUrlViaBuildView(easCliVersion, buildId, opts, uiDir);
    }
  }
  assertHttpsUrl(artifactUrl);

  const apkTmpPath = path.join('/tmp', 'eas', `happier-${environment}-android.apk`);
  await downloadWithRetries(artifactUrl, apkTmpPath, opts);
  validateApk(apkTmpPath, opts);

  fs.mkdirSync(outDirAbs, { recursive: true });

  const assetRel =
    environment === 'production'
      ? path.join(outDirRel, `happier-production-android-v${appVersion}.apk`)
      : path.join(outDirRel, 'happier-preview-android.apk');
  const assetAbs = path.resolve(repoRoot, assetRel);

  if (!dryRun) {
    fs.copyFileSync(apkTmpPath, assetAbs);
  } else {
    console.log(`[dry-run] would copy ${apkTmpPath} -> ${assetRel}`);
  }

  writeGithubOutput(githubOutput, {
    app_version: appVersion,
    asset_path: assetRel,
  });
}

await main();
