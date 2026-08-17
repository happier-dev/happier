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
import { createSignedReleaseAssetEnvelope } from '../release/lib/signed-asset-envelope.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const CANONICAL_SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$/;

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
 * Ensures `minisign` is available for local callers. GitHub Actions receives the
 * path through `$GITHUB_PATH`; local callers receive it through stdout.
 *
 * @param {string} repoRoot
 * @param {{ dryRun: boolean }} opts
 */
function ensureMinisign(repoRoot, opts) {
  const bootstrap = path.join(repoRoot, '.github', 'actions', 'bootstrap-minisign', 'bootstrap-minisign.sh');
  if (!fs.existsSync(bootstrap)) fail(`Missing minisign bootstrap script: ${path.relative(repoRoot, bootstrap)}`);
  if (opts.dryRun) {
    console.log(`[dry-run] bash ${path.relative(repoRoot, bootstrap)}`);
    return;
  }
  const output = execFileSync('bash', [bootstrap], {
    cwd: repoRoot,
    // The bootstrap action normally writes to $GITHUB_PATH, which only takes
    // effect in a later workflow step. This script must sign in the same
    // process, so force the local-CLI stdout contract and prepend it below.
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'GITHUB_PATH')),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 30 * 60_000,
  }).trim();
  if (output) process.env.PATH = `${output}${path.delimiter}${process.env.PATH ?? ''}`;
}

/**
 * @param {{ apkAbs: string; appVersion: string }} input
 */
function immutableEnvelopeAssetPaths(input) {
  const assetDir = path.dirname(input.apkAbs);
  const checksumsName = `checksums-happier-ui-mobile-v${input.appVersion}.txt`;
  return [
    input.apkAbs,
    path.join(assetDir, checksumsName),
    path.join(assetDir, `${checksumsName}.minisig`),
  ];
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
 *   assetPaths: string[];
 *   releaseMessage: string;
 * }} input
 */
function publishGitHubRelease(input) {
  const prerelease = input.releaseMeta.prerelease ? 'true' : 'false';
  const rollingTag = input.releaseMeta.rollingTag ? 'true' : 'false';
  const clobber = input.releaseMeta.rollingTag ? 'true' : 'false';
  const pruneAssets = input.releaseMeta.rollingTag ? 'true' : 'false';
  const generateNotes = input.releaseMeta.generateNotes && !input.releaseMessage.trim() ? 'true' : 'false';

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
      input.assetPaths.join('\n'),
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

/**
 * @param {{
 *   opts: { dryRun: boolean };
 *   repoRoot: string;
 *   sourceTag: string;
 *   rollingMeta: {
 *     tag: string;
 *     title: string;
 *     prerelease: boolean;
 *     notes: string;
 *   };
 *   targetSha: string;
 *   releaseMessage: string;
 * }} input
 */
function promoteRollingRelease(input) {
  const repo = String(process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? '').trim();
  run(
    input.opts,
    process.execPath,
    [
      'scripts/pipeline/github/promote-rolling-release.mjs',
      '--source-tag',
      input.sourceTag,
      '--rolling-tag',
      input.rollingMeta.tag,
      '--title',
      input.rollingMeta.title,
      '--target-sha',
      input.targetSha,
      '--prerelease',
      input.rollingMeta.prerelease ? 'true' : 'false',
      '--notes',
      input.rollingMeta.notes,
      '--release-message',
      input.releaseMessage,
      ...(repo ? ['--repo', repo] : []),
      '--public-key',
      'scripts/release/installers/happier-release.pub',
      ...(input.opts.dryRun ? ['--dry-run'] : []),
    ],
    { cwd: input.repoRoot },
  );
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'apk-path': { type: 'string' },
      'retry-version': { type: 'string', default: '' },
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

  const targetSha = String(values['target-sha'] ?? '').trim();
  if (!targetSha) fail('--target-sha is required');

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const releaseMessage = String(values['release-message'] ?? '').trim();
  const retryVersion = String(values['retry-version'] ?? '').trim();
  if (retryVersion && !CANONICAL_SEMVER_RE.test(retryVersion)) {
    fail('--retry-version must be a canonical semantic version.');
  }

  // A retry is admitted by the immutable version tag and its authorized SHA;
  // the current checkout's package.json is not part of that candidate identity.
  const appVersion = retryVersion || String(
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'package.json'), 'utf8')).version ?? '',
  ).trim();
  if (!appVersion) fail('Unable to resolve apps/ui version');

  const releaseMeta = resolveMobileReleaseMetadata({ environment, appVersion });
  const immutableReleaseMeta = resolveMobileImmutableReleaseMetadata({ environment, appVersion });

  console.log(`[pipeline] ui-mobile apk release: environment=${formatMobileReleaseEnvironment(environment)} tag=${releaseMeta.tag} version=${appVersion}`);

  if (retryVersion) {
    if (environment !== 'production' || !immutableReleaseMeta) {
      fail('--retry-version is supported only for production immutable APK releases.');
    }
    promoteRollingRelease({
      opts,
      repoRoot,
      sourceTag: immutableReleaseMeta.tag,
      rollingMeta: releaseMeta,
      targetSha,
      releaseMessage,
    });
    return;
  }

  const apkPath = String(values['apk-path'] ?? '').trim();
  if (!apkPath) fail('--apk-path is required unless --retry-version is supplied');
  const apkAbs = path.resolve(apkPath);
  if (!dryRun && !fs.existsSync(apkAbs)) {
    fail(`Missing apk at ${apkAbs}`);
  }

  if (environment === 'production' && immutableReleaseMeta) {
    const assetPaths = immutableEnvelopeAssetPaths({ apkAbs, appVersion });
    ensureMinisign(repoRoot, opts);
    if (opts.dryRun) {
      console.log(`[dry-run] sign immutable APK envelope ${assetPaths.slice(1).map((asset) => path.basename(asset)).join(', ')}`);
    } else {
      await createSignedReleaseAssetEnvelope({
        assetsDir: path.dirname(apkAbs),
        product: 'happier-ui-mobile',
        version: appVersion,
        assetNames: [path.basename(apkAbs)],
        trustedComment: `happier-ui-mobile ${appVersion} production`,
      });
    }

    console.log(`[pipeline] ui-mobile apk release: immutable_tag=${immutableReleaseMeta.tag} version=${appVersion}`);
    publishGitHubRelease({
      opts,
      repoRoot,
      releaseMeta: immutableReleaseMeta,
      targetSha,
      assetPaths,
      releaseMessage,
    });
    promoteRollingRelease({
      opts,
      repoRoot,
      sourceTag: immutableReleaseMeta.tag,
      rollingMeta: releaseMeta,
      targetSha,
      releaseMessage,
    });
    return;
  }

  publishGitHubRelease({
    opts,
    repoRoot,
    releaseMeta,
    targetSha,
    assetPaths: [apkAbs],
    releaseMessage,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
