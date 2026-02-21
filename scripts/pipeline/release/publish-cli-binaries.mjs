// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { prepareMinisignSecretKeyFile } from './lib/binary-release.mjs';
import { withCurrentVersionLine } from './lib/rolling-release-notes.mjs';
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
 * @param {string} version
 */
function normalizeBase(version) {
  const m = String(version ?? '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) fail(`Invalid version: ${version}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * @param {string} pkgJsonPath
 * @param {string} nextVersion
 * @returns {() => void}
 */
function patchPackageVersion(pkgJsonPath, nextVersion) {
  const raw = fs.readFileSync(pkgJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const prevVersion = String(parsed.version ?? '').trim();
  if (!prevVersion) fail(`package.json missing version: ${pkgJsonPath}`);
  parsed.version = nextVersion;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return () => {
    fs.writeFileSync(pkgJsonPath, raw, 'utf8');
  };
}

/**
 * @param {string} repoRoot
 */
function readCliVersion(repoRoot) {
  const pkgJsonPath = withinRepo(repoRoot, path.join('apps', 'cli', 'package.json'));
  const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const version = String(parsed?.version ?? '').trim();
  if (!version) fail(`package.json missing version: ${path.relative(repoRoot, pkgJsonPath)}`);
  return version;
}

/**
 * Derive a stable preview prerelease suffix matching CI conventions.
 * @returns {string}
 */
function resolvePreviewSuffix() {
  const runRaw = String(process.env.GITHUB_RUN_NUMBER ?? '').trim();
  const attemptRaw = String(process.env.GITHUB_RUN_ATTEMPT ?? '').trim();

  const runNumber = runRaw ? Number(runRaw) : NaN;
  const attemptNumber = attemptRaw ? Number(attemptRaw) : NaN;

  const run = Number.isFinite(runNumber) ? Math.max(0, Math.floor(runNumber)) : Math.floor(Date.now() / 1000);
  const attempt = Number.isFinite(attemptNumber) ? Math.max(1, Math.floor(attemptNumber)) : Math.max(1, Math.floor(process.pid));
  return `preview.${run}.${attempt}`;
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
    fail('[pipeline] MINISIGN_SECRET_KEY is required to publish signed CLI release artifacts.');
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
  const rel = 'dist/release-assets/cli';
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
    fail('Stable CLI binary publishing is disabled. Re-run with --allow-stable true if intentional.');
  }

  const dryRun = values['dry-run'] === true;
  const runContracts = resolveAutoBool(values['run-contracts'], '--run-contracts', process.env.GITHUB_ACTIONS === 'true');
  const checkInstallers = parseBool(values['check-installers'], '--check-installers');
  const releaseMessage = String(values['release-message'] ?? '').trim();

  const opts = { dryRun };

  const embeddedPolicy = channel === 'stable' ? 'production' : 'preview';

  const rollingTag = channel === 'preview' ? 'cli-preview' : 'cli-stable';
  const rollingTitle = channel === 'preview' ? 'Happier CLI Preview' : 'Happier CLI Stable';
  const prerelease = channel === 'preview' ? 'true' : 'false';
  const notesBase = channel === 'preview' ? 'Rolling preview CLI binaries.' : 'Rolling stable CLI binaries.';

  const targetSha = run(opts, 'git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).trim() || 'UNKNOWN_SHA';

  console.log(`[pipeline] cli-binaries: channel=${channel} tag=${rollingTag}`);

  await preflightMinisignKey(opts);

  if (runContracts) {
    run(opts, 'yarn', ['-s', 'test:release:contracts'], {
      cwd: repoRoot,
      env: { ...process.env, HAPPIER_EMBEDDED_POLICY_ENV: embeddedPolicy },
    });
  }
  if (checkInstallers) {
    run(opts, process.execPath, ['scripts/pipeline/release/sync-installers.mjs', '--check'], { cwd: repoRoot });
  }

  ensureMinisign(repoRoot, opts);

  const cliPkgJson = withinRepo(repoRoot, path.join('apps', 'cli', 'package.json'));
  const originalVersion = readCliVersion(repoRoot);
  const base = normalizeBase(originalVersion);
  const version = channel === 'preview' ? `${base}-${resolvePreviewSuffix()}` : originalVersion;
  const notes = withCurrentVersionLine(notesBase, version);

  /** @type {null | (() => void)} */
  let restoreVersion = null;
  try {
    if (channel === 'preview') {
      if (dryRun) {
        console.log(`[dry-run] patch ${path.relative(repoRoot, cliPkgJson)} version -> ${version}`);
      } else {
        restoreVersion = patchPackageVersion(cliPkgJson, version);
      }
    }

    await ensureCleanArtifactsDir(repoRoot, opts);

    run(
      opts,
      process.execPath,
      ['scripts/pipeline/release/build-cli-binaries.mjs', '--channel', channel, '--version', version],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_EMBEDDED_POLICY_ENV: process.env.HAPPIER_EMBEDDED_POLICY_ENV ?? embeddedPolicy,
        },
      },
    );

    const artifactsDir = withinRepo(repoRoot, 'dist/release-assets/cli');
    const checksums = withinRepo(repoRoot, `dist/release-assets/cli/checksums-happier-v${version}.txt`);
    const signature = withinRepo(repoRoot, `dist/release-assets/cli/checksums-happier-v${version}.txt.minisig`);
    const manifestPath = withinRepo(repoRoot, `dist/release-assets/cli/manifests/v1/happier/${channel}/latest.json`);

    const repoSlug = resolveGitHubRepoSlug({ repoRoot, env: process.env });
    if (!repoSlug) {
      fail(
        [
          'Unable to resolve GitHub repo slug for manifest URL generation.',
          'Set GH_REPO=owner/repo (recommended) or ensure git remote.origin.url points at github.com.',
        ].join('\n'),
      );
    }
    const assetsBaseUrl = `https://github.com/${repoSlug}/releases/download/${rollingTag}`;

    run(
      opts,
      process.execPath,
      [
        'scripts/pipeline/release/publish-manifests.mjs',
        '--product=happier',
        '--channel',
        channel,
        '--version',
        version,
        '--artifacts-dir',
        'dist/release-assets/cli',
        '--out-dir',
        'dist/release-assets/cli/manifests',
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
        rollingTag,
        '--title',
        rollingTitle,
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
    if (!dryRun) {
      console.log(`[pipeline] published GitHub rolling release: ${rollingTag}`);
      console.log(`[pipeline] note: GitHub may not update 'Published' timestamps for rolling releases; verify assets on tag '${rollingTag}'.`);
    }

    const versionTag = `cli-v${version}`;
    const versionTitle = `Happier CLI v${version}`;
    const versionNotes = channel === 'preview' ? `CLI preview build v${version}.` : `CLI stable release v${version}.`;

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
    if (!dryRun) {
      console.log(`[pipeline] published GitHub versioned release: ${versionTag}`);
    }
  } finally {
    if (restoreVersion) {
      restoreVersion();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
