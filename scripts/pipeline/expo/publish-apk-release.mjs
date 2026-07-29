// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES,
  formatMobileReleaseEnvironment,
  normalizeMobileReleaseEnvironment,
  resolveMobileImmutableReleaseMetadata,
  resolveMobileReleaseMetadata,
  supportsMobileApkReleasePublishing,
} from './mobile-release-environments.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
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

/**
 * @param {string} apkAbs
 */
function deriveRollingStableApkPath(apkAbs) {
  const dir = path.dirname(apkAbs);
  const ext = path.extname(apkAbs) || '.apk';
  return path.join(dir, `happier-production-android${ext}`);
}

/**
 * @param {{
 *   opts: { dryRun: boolean };
 *   repoRoot: string;
 *   releaseMeta: {
 *     tag: string;
 *     title: string;
 *     prerelease: boolean;
 *     rollingTag: boolean;
 *     generateNotes: boolean;
 *     notes: string;
 *   };
 *   targetSha: string;
 *   apkAbs: string;
 *   releaseMessage: string;
 * }} input
 */
function publishGitHubRelease(input) {
  const prerelease = input.releaseMeta.prerelease ? 'true' : 'false';
  const rollingTag = input.releaseMeta.rollingTag ? 'true' : 'false';
  const clobber = input.releaseMeta.rollingTag ? 'true' : 'false';
  const pruneAssets = input.releaseMeta.rollingTag ? 'true' : 'false';
  const generateNotes = input.releaseMeta.generateNotes ? 'true' : 'false';

  run(
    input.opts,
    process.execPath,
    [
      'scripts/pipeline/github/publish-release.mjs',
      '--tag',
      input.releaseMeta.tag,
      '--title',
      input.releaseMeta.title,
      '--target-sha',
      input.targetSha,
      '--prerelease',
      prerelease,
      '--rolling-tag',
      rollingTag,
      '--generate-notes',
      generateNotes,
      '--notes',
      input.releaseMeta.notes,
      '--assets',
      input.apkAbs,
      '--clobber',
      clobber,
      '--prune-assets',
      pruneAssets,
      '--release-message',
      input.releaseMessage,
      ...(input.opts.dryRun ? ['--dry-run'] : []),
    ],
    { cwd: input.repoRoot },
  );
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

  const requestedEnvironment = String(values.environment ?? '').trim();
  const environment = normalizeMobileReleaseEnvironment(requestedEnvironment);
  if (!environment || !supportsMobileApkReleasePublishing(environment)) {
    fail(`--environment must be ${JSON.stringify(MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES)} (got: ${requestedEnvironment || '<empty>'})`);
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

  const releaseMeta = resolveMobileReleaseMetadata({ environment, appVersion });
  const immutableReleaseMeta = resolveMobileImmutableReleaseMetadata({ environment, appVersion });
  const releaseMessage = String(values['release-message'] ?? '').trim();

  console.log(`[pipeline] ui-mobile apk release: environment=${formatMobileReleaseEnvironment(environment)} tag=${releaseMeta.tag} version=${appVersion}`);

  let rollingApkAbs = apkAbs;
  if (environment === 'production' && releaseMeta.tag === 'ui-mobile-stable') {
    rollingApkAbs = deriveRollingStableApkPath(apkAbs);
    if (!opts.dryRun && rollingApkAbs !== apkAbs) {
      fs.copyFileSync(apkAbs, rollingApkAbs);
    }
  }

  publishGitHubRelease({
    opts,
    repoRoot,
    releaseMeta,
    targetSha,
    apkAbs: rollingApkAbs,
    releaseMessage,
  });

  if (immutableReleaseMeta) {
    console.log(`[pipeline] ui-mobile apk release: immutable_tag=${immutableReleaseMeta.tag} version=${appVersion}`);
    publishGitHubRelease({
      opts,
      repoRoot,
      releaseMeta: immutableReleaseMeta,
      targetSha,
      apkAbs,
      releaseMessage,
    });
  }
}

main();
