// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import {
  formatPublicReleaseChannel,
  formatPublicReleaseChannelChoices,
  getPublicReleaseRingEntry,
  normalizePublicReleaseChannel,
  resolveEmbeddedPolicyForChannel,
  resolveExpoAppEnvironmentForChannel,
  resolveRollingPrerelease,
  resolveRollingReleaseLabel,
  resolveRollingReleaseTagSuffix,
  resolveRollingVersionSuffix,
} from './lib/public-release-rings.mjs';
import { withCurrentVersionLine } from './lib/rolling-release-notes.mjs';
import { resolveRollingRecoveryVersion } from './lib/rolling-version-allocation.mjs';
import { resolveGitHubRepoSlug } from '../github/resolve-github-repo-slug.mjs';

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
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} autoValue
 */
function resolveAutoBool(value, name, autoValue) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return autoValue;
  return parseBool(raw, name);
}

/**
 * @param {string} repoRoot
 * @param {string} rel
 */
function withinRepo(repoRoot, rel) {
  return path.resolve(repoRoot, rel);
}

/**
 * @param {string} version
 */
function normalizeBase(version) {
  const m = String(version ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) fail(`Invalid ui version: ${version}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 */
function computeUiVersion(channel, baseVersion) {
  if (channel === 'stable') return baseVersion;
  const base = normalizeBase(baseVersion);
  return `${base}-${resolveRollingVersionSuffix(channel)}`;
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
 * Ensures `minisign` is available on PATH. Compatible with local runs (prints bin dir on stdout)
 * and GitHub Actions runs (writes to $GITHUB_PATH).
 * @param {string} repoRoot
 * @param {{ dryRun: boolean }} opts
 */
function ensureMinisign(repoRoot, opts) {
  const bootstrap = withinRepo(repoRoot, '.github/actions/bootstrap-minisign/bootstrap-minisign.sh');
  if (!fs.existsSync(bootstrap)) fail(`Missing minisign bootstrap script: ${path.relative(repoRoot, bootstrap)}`);
  const out = run(opts, 'bash', [bootstrap], { cwd: repoRoot, stdio: 'pipe' }).trim();
  if (out) {
    process.env.PATH = `${out}${path.delimiter}${process.env.PATH ?? ''}`;
  }
}

async function preflightMinisignKey({ dryRun }) {
  if (dryRun) return;
  const keyRaw = String(process.env.MINISIGN_SECRET_KEY ?? '').trim();
  if (!keyRaw) {
    fail('[pipeline] MINISIGN_SECRET_KEY is required to publish signed ui-web release artifacts.');
  }
  const { prepareMinisignSecretKeyFile } = await import('./lib/minisign-secret-key.mjs');
  const prepared = await prepareMinisignSecretKeyFile(keyRaw);
  if (prepared.temp) {
    await rm(prepared.cleanupPath ?? prepared.path, { recursive: true, force: true });
  }
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      'allow-stable': { type: 'string', default: 'false' },
      'release-message': { type: 'string', default: '' },
      'run-contracts': { type: 'string', default: 'auto' },
      'check-installers': { type: 'string', default: 'true' },
      phase: { type: 'string', default: 'publish' },
      version: { type: 'string', default: '' },
      'authorized-sha': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const requestedChannel = String(values.channel ?? '').trim();
  if (!requestedChannel) fail('--channel is required');
  const channel = normalizePublicReleaseChannel(requestedChannel);
  if (!channel) {
    fail(`--channel must be ${JSON.stringify(formatPublicReleaseChannelChoices())} (got: ${requestedChannel})`);
  }
  const allowStable = parseBool(values['allow-stable'], '--allow-stable');
  if (channel === 'stable' && !allowStable) {
    fail("Stable UI web publishing is disabled. Re-run with --allow-stable true if intentional.");
  }

  const dryRun = values['dry-run'] === true;
  const runContracts = resolveAutoBool(values['run-contracts'], '--run-contracts', process.env.GITHUB_ACTIONS === 'true');
  const checkInstallers = parseBool(values['check-installers'], '--check-installers');
  const releaseMessage = String(values['release-message'] ?? '').trim();
  const phase = String(values.phase ?? 'publish').trim();
  if (!['publish', 'promote-rolling'].includes(phase)) fail('--phase must be publish|promote-rolling');
  const explicitVersion = String(values.version ?? '').trim();
  const authorizedSha = String(values['authorized-sha'] ?? '').trim().toLowerCase();
  if (phase === 'promote-rolling' && !explicitVersion) fail('--version is required for same-version rolling promotion');
  if (phase === 'promote-rolling' && !/^[a-f0-9]{40}$/.test(authorizedSha)) {
    fail('--authorized-sha must be a full 40-character commit id for rolling recovery');
  }
  const repoSlug = resolveGitHubRepoSlug({ repoRoot });
  if (!repoSlug) fail('Unable to resolve GitHub repo slug. Set GH_REPO=owner/repo or configure a github.com origin remote.');

  const opts = { dryRun };

  const releaseRing = getPublicReleaseRingEntry(channel);
  const uiVersion = phase === 'promote-rolling'
    ? (
        await resolveRollingRecoveryVersion({
          repoRoot,
          productId: 'ui-web',
          channel,
          explicitVersion,
          env: process.env,
        })
      ).version
    : (() => {
        const pkg = JSON.parse(fs.readFileSync(withinRepo(repoRoot, 'apps/ui/package.json'), 'utf8'));
        const baseVersion = String(pkg.version ?? '').trim();
        if (!baseVersion) fail('Unable to resolve apps/ui version');
        return computeUiVersion(channel, baseVersion);
      })();

  const tag = `ui-web-${resolveRollingReleaseTagSuffix(channel)}`;
  const title = `Happier UI Web Bundle ${resolveRollingReleaseLabel(channel)}`;
  const prerelease = resolveRollingPrerelease(channel);
  const notesBase = `Rolling ${releaseRing.publicLabel} UI web bundle release.`;
  const notes = withCurrentVersionLine(notesBase, uiVersion);
  const versionTag = `ui-web-v${uiVersion}`;
  const versionTitle = `Happier UI Web Bundle v${uiVersion}`;
  const versionNotes = `UI web bundle ${releaseRing.publicLabel} build v${uiVersion}.`;
  const targetSha = phase === 'promote-rolling'
    ? authorizedSha
    : run(opts, 'git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).trim() || 'UNKNOWN_SHA';

  const appEnv = resolveExpoAppEnvironmentForChannel(channel);
  const embeddedPolicy = resolveEmbeddedPolicyForChannel(channel);
  const updatesChannel = releaseRing.expoUpdatesChannel;

  console.log(`[pipeline] ui-web: channel=${formatPublicReleaseChannel(channel)} tag=${tag} version=${uiVersion}`);

  if (phase !== 'promote-rolling') await preflightMinisignKey(opts);

  if (runContracts) {
    run(opts, 'yarn', ['-s', 'test:release:contracts'], { cwd: repoRoot, env: { ...process.env, HAPPIER_EMBEDDED_POLICY_ENV: embeddedPolicy } });
  }
  if (checkInstallers) {
    run(opts, process.execPath, ['scripts/pipeline/release/sync-installers.mjs', '--check'], { cwd: repoRoot });
  }

  ensureMinisign(repoRoot, opts);

  if (phase === 'promote-rolling') {
    run(opts, process.execPath, [
      'scripts/pipeline/github/promote-rolling-release.mjs',
      '--source-tag', versionTag,
      '--rolling-tag', tag,
      '--title', title,
      '--target-sha', targetSha,
      '--prerelease', prerelease,
      '--notes', notes,
      '--release-message', releaseMessage,
      '--repo', repoSlug,
      '--public-key', 'scripts/release/installers/happier-release.pub',
      ...(dryRun ? ['--dry-run'] : []),
    ], { cwd: repoRoot });
    return;
  }

  run(
    opts,
      process.execPath,
    [
      'scripts/pipeline/release/build-ui-web-bundle.mjs',
      '--channel',
      channel,
      '--version',
      uiVersion,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        APP_ENV: process.env.APP_ENV ?? appEnv,
        EXPO_UPDATES_CHANNEL: process.env.EXPO_UPDATES_CHANNEL ?? updatesChannel,
        HAPPIER_EMBEDDED_POLICY_ENV: process.env.HAPPIER_EMBEDDED_POLICY_ENV ?? embeddedPolicy,
      },
    },
  );

  const artifactsDir = withinRepo(repoRoot, 'dist/release-assets/ui-web');
  const checksums = withinRepo(repoRoot, `dist/release-assets/ui-web/checksums-happier-ui-web-v${uiVersion}.txt`);
  const tarball = withinRepo(repoRoot, `dist/release-assets/ui-web/happier-ui-web-v${uiVersion}-web-any.tar.gz`);
  const signature = withinRepo(repoRoot, `dist/release-assets/ui-web/checksums-happier-ui-web-v${uiVersion}.txt.minisig`);

  if (!dryRun) {
    for (const p of [tarball, checksums, signature]) {
      if (!fs.existsSync(p)) fail(`Missing expected artifact: ${path.relative(repoRoot, p)}`);
    }
  } else {
    console.log(`[dry-run] would verify artifacts under ${path.relative(repoRoot, artifactsDir)}`);
  }

  run(
    opts,
      process.execPath,
    [
      'scripts/pipeline/release/verify-artifacts.mjs',
      '--artifacts-dir',
      path.relative(repoRoot, artifactsDir),
      '--checksums',
      path.relative(repoRoot, checksums),
      '--public-key',
      'scripts/release/installers/happier-release.pub',
      '--skip-smoke',
    ],
    { cwd: repoRoot },
  );

  run(
    opts,
    process.execPath,
    [
      'scripts/pipeline/github/publish-release.mjs',
      '--tag',
      versionTag,
      '--title',
      versionTitle,
      '--target-sha',
      targetSha,
      '--prerelease',
      prerelease,
      '--rolling-tag',
      'false',
      '--generate-notes',
      'true',
      '--notes',
      versionNotes,
      '--assets-dir',
      path.relative(repoRoot, artifactsDir),
      '--clobber',
      'false',
      '--prune-assets',
      'false',
      '--release-message',
      releaseMessage,
      ...(dryRun ? ['--dry-run'] : []),
    ],
    { cwd: repoRoot },
  );

  run(opts, process.execPath, [
    'scripts/pipeline/github/promote-rolling-release.mjs',
    '--source-tag', versionTag,
    '--rolling-tag', tag,
    '--title', title,
    '--target-sha', targetSha,
    '--prerelease', prerelease,
    '--notes', notes,
    '--release-message', releaseMessage,
    '--repo', repoSlug,
    '--public-key', 'scripts/release/installers/happier-release.pub',
    ...(dryRun ? ['--dry-run'] : []),
  ], { cwd: repoRoot });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
