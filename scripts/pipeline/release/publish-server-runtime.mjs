// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { prepareMinisignSecretKeyFile } from './lib/binary-release.mjs';
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
    fail('[pipeline] MINISIGN_SECRET_KEY is required to publish signed server runtime release artifacts.');
  }
  const prepared = await prepareMinisignSecretKeyFile(keyRaw);
  if (prepared.temp) {
    await rm(prepared.cleanupPath ?? prepared.path, { recursive: true, force: true });
  }
}

/**
 * publish-release uploads every file under --assets-dir. Make sure we start from a clean directory so
 * we don't accidentally re-upload stale artifacts from previous local runs.
 * @param {string} repoRoot
 * @param {{ dryRun: boolean }} opts
 */
async function ensureCleanArtifactsDir(repoRoot, opts) {
  const rel = 'dist/release-assets/server';
  const abs = withinRepo(repoRoot, rel);
  const prefix = opts.dryRun ? '[dry-run]' : '[pipeline]';
  console.log(`${prefix} clean artifacts dir: ${rel}`);
  if (opts.dryRun) return;
  await rm(abs, { recursive: true, force: true });
  await mkdir(abs, { recursive: true });
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
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const channel = String(values.channel ?? '').trim();
  if (!channel) fail('--channel is required');
  if (channel !== 'preview' && channel !== 'stable') {
    fail(`--channel must be 'preview' or 'stable' (got: ${channel})`);
  }
  const allowStable = parseBool(values['allow-stable'], '--allow-stable');
  if (channel === 'stable' && !allowStable) {
    fail('Stable server runtime publishing is disabled. Re-run with --allow-stable true if intentional.');
  }

  const dryRun = values['dry-run'] === true;
  const runContracts = resolveAutoBool(values['run-contracts'], '--run-contracts', process.env.GITHUB_ACTIONS === 'true');
  const checkInstallers = parseBool(values['check-installers'], '--check-installers');
  const releaseMessage = String(values['release-message'] ?? '').trim();

  const opts = { dryRun };

  const serverPkg = JSON.parse(fs.readFileSync(withinRepo(repoRoot, 'apps/server/package.json'), 'utf8'));
  const serverVersion = String(serverPkg.version ?? '').trim();
  if (!serverVersion) fail('Unable to resolve apps/server version');

  const tag = channel === 'preview' ? 'server-preview' : 'server-stable';
  const title = channel === 'preview' ? 'Happier Server Preview' : 'Happier Server Stable';
  const prerelease = channel === 'preview' ? 'true' : 'false';
  const notes = channel === 'preview' ? 'Rolling preview server runtime release.' : 'Stable server runtime release.';
  const versionTag = `server-v${serverVersion}`;
  const versionTitle = `Happier Server v${serverVersion}`;
  const versionNotes =
    channel === 'preview' ? `Server runtime preview build v${serverVersion}.` : `Server runtime stable release v${serverVersion}.`;
  const targetSha = run(opts, 'git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).trim() || 'UNKNOWN_SHA';

  const embeddedPolicy = channel === 'stable' ? 'production' : 'preview';

  console.log(`[pipeline] server-runtime: channel=${channel} tag=${tag} version=${serverVersion}`);

  await preflightMinisignKey(opts);

  if (runContracts) {
    run(opts, 'yarn', ['-s', 'test:release:contracts'], { cwd: repoRoot, env: { ...process.env, HAPPIER_EMBEDDED_POLICY_ENV: embeddedPolicy } });
  }
  if (checkInstallers) {
    run(opts, process.execPath, ['scripts/pipeline/release/sync-installers.mjs', '--check'], { cwd: repoRoot });
  }

  ensureMinisign(repoRoot, opts);

  await ensureCleanArtifactsDir(repoRoot, opts);

  run(
    opts,
    process.execPath,
    ['scripts/pipeline/release/build-server-binaries.mjs', '--channel', channel, '--version', serverVersion],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_EMBEDDED_POLICY_ENV: process.env.HAPPIER_EMBEDDED_POLICY_ENV ?? embeddedPolicy,
      },
    },
  );

  const artifactsDir = withinRepo(repoRoot, 'dist/release-assets/server');
  const checksums = withinRepo(repoRoot, `dist/release-assets/server/checksums-happier-server-v${serverVersion}.txt`);
  const signature = withinRepo(repoRoot, `dist/release-assets/server/checksums-happier-server-v${serverVersion}.txt.minisig`);
  const manifestPath = withinRepo(repoRoot, `dist/release-assets/server/manifests/v1/happier-server/${channel}/latest.json`);

  const repoSlug = resolveGitHubRepoSlug({ repoRoot, env: process.env });
  if (!repoSlug) {
    fail(
      [
        'Unable to resolve GitHub repo slug for manifest URL generation.',
        'Set GH_REPO=owner/repo (recommended) or ensure git remote.origin.url points at github.com.',
      ].join('\n'),
    );
  }
  const assetsBaseUrl = `https://github.com/${repoSlug}/releases/download/${tag}`;

  run(
    opts,
      process.execPath,
    [
      'scripts/pipeline/release/publish-manifests.mjs',
      '--product=happier-server',
      '--channel',
      channel,
      '--version',
      serverVersion,
      '--artifacts-dir',
      'dist/release-assets/server',
      '--out-dir',
      'dist/release-assets/server/manifests',
      '--assets-base-url',
      assetsBaseUrl,
      '--commit-sha',
      targetSha,
      '--workflow-run-id',
      String(process.env.GITHUB_RUN_ID ?? ''),
    ],
    { cwd: repoRoot },
  );

  if (!dryRun) {
    for (const p of [checksums, signature, manifestPath]) {
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
      tag,
      '--title',
      title,
      '--target-sha',
      targetSha,
      '--prerelease',
      prerelease,
      '--rolling-tag',
      'true',
      '--generate-notes',
      'false',
      '--notes',
      notes,
      '--assets-dir',
      path.relative(repoRoot, artifactsDir),
      '--clobber',
      'true',
      '--prune-assets',
      'true',
      '--release-message',
      releaseMessage,
      ...(dryRun ? ['--dry-run'] : []),
    ],
    { cwd: repoRoot },
  );

  // Version tag (immutable) — published alongside rolling tags for traceability.
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
      'false',
      '--notes',
      versionNotes,
      '--assets-dir',
      path.relative(repoRoot, artifactsDir),
      '--clobber',
      'true',
      '--prune-assets',
      'true',
      '--release-message',
      releaseMessage,
      ...(dryRun ? ['--dry-run'] : []),
    ],
    { cwd: repoRoot },
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
