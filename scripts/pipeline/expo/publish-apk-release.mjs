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
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string> }} [extra]
 */
function run(opts, cmd, args, extra) {
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return;
  }

  execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...(extra?.env ?? {}) },
    stdio: 'inherit',
    timeout: 30 * 60_000,
  });
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'apk-path': { type: 'string' },
      'target-sha': { type: 'string' },
      'release-message': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const environment = String(values.environment ?? '').trim();
  if (!environment) fail('--environment is required');
  if (environment !== 'preview' && environment !== 'production') {
    fail(`--environment must be 'preview' or 'production' (got: ${environment})`);
  }

  const apkPath = String(values['apk-path'] ?? '').trim();
  if (!apkPath) fail('--apk-path is required');
  const apkAbs = path.resolve(apkPath);

  const targetSha = String(values['target-sha'] ?? '').trim();
  if (!targetSha) fail('--target-sha is required');

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  if (!dryRun && !fs.existsSync(apkAbs)) {
    fail(`Missing apk at ${apkAbs}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'package.json'), 'utf8'));
  const appVersion = String(pkg.version ?? '').trim();
  if (!appVersion) fail('Unable to resolve apps/ui version');

  const isPreview = environment === 'preview';
  const tag = isPreview ? 'ui-mobile-preview' : `ui-mobile-v${appVersion}`;
  const title = isPreview ? 'Happier UI Mobile Preview' : `Happier UI Mobile v${appVersion}`;
  const prerelease = isPreview ? 'true' : 'false';
  const rollingTag = isPreview ? 'true' : 'false';
  const pruneAssets = isPreview ? 'true' : 'false';
  const generateNotes = isPreview ? 'false' : 'true';
  const notes = isPreview ? 'Rolling preview build.' : '';
  const releaseMessage = String(values['release-message'] ?? '').trim();

  console.log(`[pipeline] ui-mobile apk release: environment=${environment} tag=${tag} version=${appVersion}`);

  run(
    opts,
    process.execPath,
    [
      'scripts/pipeline/github/publish-release.mjs',
      '--tag',
      tag,
      '--title',
      title,
      '--target-sha',
      targetSha,
      '--prerelease',
      prerelease,
      '--rolling-tag',
      rollingTag,
      '--generate-notes',
      generateNotes,
      '--notes',
      notes,
      '--assets',
      apkAbs,
      '--clobber',
      'true',
      '--prune-assets',
      pruneAssets,
      '--release-message',
      releaseMessage,
      ...(dryRun ? ['--dry-run'] : []),
    ],
    { cwd: repoRoot },
  );
}

main();

