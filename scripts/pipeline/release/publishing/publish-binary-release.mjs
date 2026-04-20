// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  formatPublicReleaseChannel,
  formatPublicReleaseChannelChoices,
  getPublicReleaseRingEntry,
  normalizePublicReleaseChannel,
  resolveEmbeddedPolicyForChannel,
  resolveRollingPrerelease,
  resolveRollingReleaseLabel,
  resolveRollingReleaseTagSuffix,
  resolveRollingVersionSuffix,
} from '../lib/public-release-rings.mjs';
import { withCurrentVersionLine } from '../lib/rolling-release-notes.mjs';
import { resolveGitHubRepoSlug } from '../../github/resolve-github-repo-slug.mjs';
import { prepareBinaryReleaseAssets } from './prepare-binary-assets.mjs';
import { getBinaryPublishProductSpec } from './product-specs.mjs';

const GITHUB_RELEASE_SCRIPT_RELATIVE_PATH = 'scripts/pipeline/github/publish-release.mjs';
const INSTALLER_SYNC_SCRIPT_RELATIVE_PATH = 'scripts/pipeline/release/sync-installers.mjs';
const MINISIGN_BOOTSTRAP_RELATIVE_PATH = '.github/actions/bootstrap-minisign/bootstrap-minisign.sh';

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be 'true' or 'false' (got: ${value})`);
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
function normalizeBaseVersion(version) {
  const match = String(version ?? '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid version: ${version}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * @param {string} packageJsonPath
 * @param {string} nextVersion
 * @returns {() => void}
 */
function patchPackageVersion(packageJsonPath, nextVersion) {
  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const previousVersion = String(parsed.version ?? '').trim();
  if (!previousVersion) {
    throw new Error(`package.json missing version: ${packageJsonPath}`);
  }
  parsed.version = nextVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return () => {
    fs.writeFileSync(packageJsonPath, raw, 'utf8');
  };
}

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof getBinaryPublishProductSpec>} productSpec
 */
function readBaseVersion(repoRoot, productSpec) {
  const packageJsonPath = withinRepo(repoRoot, productSpec.packageJsonPath);
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = String(parsed?.version ?? '').trim();
  if (!version) {
    throw new Error(`package.json missing version: ${path.relative(repoRoot, packageJsonPath)}`);
  }
  return version;
}

/**
 * @param {string} repoRoot
 * @param {ReturnType<typeof getBinaryPublishProductSpec>} productSpec
 */
function ensureMinisign(repoRoot, productSpec, opts) {
  const bootstrap = withinRepo(repoRoot, MINISIGN_BOOTSTRAP_RELATIVE_PATH);
  if (!fs.existsSync(bootstrap)) {
    throw new Error(`Missing minisign bootstrap script: ${path.relative(repoRoot, bootstrap)}`);
  }
  const out = run(opts, 'bash', [bootstrap], { cwd: repoRoot, stdio: 'pipe' }).trim();
  if (out) {
    process.env.PATH = `${out}${path.delimiter}${process.env.PATH ?? ''}`;
  }
}

/**
 * @param {ReturnType<typeof getBinaryPublishProductSpec>} productSpec
 * @param {{ dryRun: boolean }} opts
 */
async function preflightMinisignKey(productSpec, opts) {
  if (opts.dryRun) return;
  const keyRaw = String(process.env.MINISIGN_SECRET_KEY ?? '').trim();
  if (!keyRaw) {
    throw new Error(`[pipeline] MINISIGN_SECRET_KEY is required to publish signed ${productSpec.minisignRequirementLabel}.`);
  }
  const { prepareMinisignSecretKeyFile } = await import('../lib/binary-release.mjs');
  const prepared = await prepareMinisignSecretKeyFile(keyRaw);
  if (prepared.temp) {
    await rm(prepared.cleanupPath ?? prepared.path, { recursive: true, force: true });
  }
}

/**
 * @param {ReturnType<typeof getBinaryPublishProductSpec>} productSpec
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 * @param {string} baseVersion
 */
function computePublishVersion(productSpec, channel, baseVersion) {
  if (channel === 'stable') {
    return baseVersion;
  }
  return `${normalizeBaseVersion(baseVersion)}-${resolveRollingVersionSuffix(channel)}`;
}

/**
 * @param {string[]} argv
 */
function parsePublishBinaryReleaseArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      product: { type: 'string' },
      channel: { type: 'string' },
      'allow-stable': { type: 'string', default: 'false' },
      'release-message': { type: 'string', default: '' },
      'run-contracts': { type: 'string', default: 'auto' },
      'check-installers': { type: 'string', default: 'true' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  }).values;
}

/**
 * @param {{ productId?: string; argv?: string[]; cwd?: string }} [options]
 */
export async function publishBinaryReleaseMain(options = {}) {
  const repoRoot = path.resolve(options.cwd ?? process.cwd());
  const values = parsePublishBinaryReleaseArgs(options.argv ?? process.argv.slice(2));

  const requestedProductId = String(options.productId ?? values.product ?? '').trim();
  if (!requestedProductId) {
    throw new Error('--product is required');
  }
  const productSpec = getBinaryPublishProductSpec(requestedProductId);

  const requestedChannel = String(values.channel ?? '').trim();
  if (!requestedChannel) {
    throw new Error('--channel is required');
  }
  const channel = normalizePublicReleaseChannel(requestedChannel);
  if (!channel) {
    throw new Error(
      `--channel must be ${JSON.stringify(formatPublicReleaseChannelChoices())} (got: ${requestedChannel})`,
    );
  }

  const allowStable = parseBool(values['allow-stable'], '--allow-stable');
  if (channel === 'stable' && !allowStable) {
    throw new Error(`Stable ${productSpec.publishSurfaceLabel} is disabled. Re-run with --allow-stable true if intentional.`);
  }

  const opts = { dryRun: values['dry-run'] === true };
  const runContracts = resolveAutoBool(values['run-contracts'], '--run-contracts', process.env.GITHUB_ACTIONS === 'true');
  const checkInstallers = parseBool(values['check-installers'], '--check-installers');
  const releaseMessage = String(values['release-message'] ?? '').trim();

  const releaseRing = getPublicReleaseRingEntry(channel);
  const embeddedPolicy = resolveEmbeddedPolicyForChannel(channel);
  const baseVersion = readBaseVersion(repoRoot, productSpec);
  const version = computePublishVersion(productSpec, channel, baseVersion);
  const rollingTag = `${productSpec.rollingTagPrefix}-${resolveRollingReleaseTagSuffix(channel)}`;
  const rollingTitle = `${productSpec.releaseTitleBase} ${resolveRollingReleaseLabel(channel)}`;
  const prerelease = resolveRollingPrerelease(channel);
  const notesBase = `Rolling ${releaseRing.publicLabel} ${productSpec.rollingNotesSubject}.`;
  const notes = withCurrentVersionLine(notesBase, version);
  const versionTag = `${productSpec.versionTagPrefix}${version}`;
  const versionTitle = `${productSpec.releaseTitleBase} v${version}`;
  const versionNotes = `${productSpec.versionNotesSubject} ${releaseRing.publicLabel} build v${version}.`;
  const targetSha = run(opts, 'git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).trim() || 'UNKNOWN_SHA';

  console.log(
    `[pipeline] ${productSpec.pipelineLabel}: channel=${formatPublicReleaseChannel(channel)} tag=${rollingTag}${
      productSpec.id === 'server' ? ` version=${version}` : ''
    }`,
  );

  await preflightMinisignKey(productSpec, opts);

  if (runContracts) {
    run(opts, 'yarn', ['-s', 'test:release:contracts'], {
      cwd: repoRoot,
      env: { ...process.env, HAPPIER_EMBEDDED_POLICY_ENV: embeddedPolicy },
    });
  }
  if (checkInstallers) {
    run(opts, process.execPath, [INSTALLER_SYNC_SCRIPT_RELATIVE_PATH, '--check'], { cwd: repoRoot });
  }

  ensureMinisign(repoRoot, productSpec, opts);

  const packageJsonPath = withinRepo(repoRoot, productSpec.packageJsonPath);
  /** @type {null | (() => void)} */
  let restoreVersion = null;
  try {
    if (productSpec.patchPackageVersionOnRolling && channel !== 'stable') {
      if (opts.dryRun) {
        console.log(`[dry-run] patch ${path.relative(repoRoot, packageJsonPath)} version -> ${version}`);
      } else {
        restoreVersion = patchPackageVersion(packageJsonPath, version);
      }
    }

    const repoSlug = resolveGitHubRepoSlug({ repoRoot, env: process.env });
    if (!repoSlug) {
      throw new Error(
        [
          'Unable to resolve GitHub repo slug for manifest URL generation.',
          'Set GH_REPO=owner/repo (recommended) or ensure git remote.origin.url points at github.com.',
        ].join('\n'),
      );
    }
    const assetsBaseUrl = `https://github.com/${repoSlug}/releases/download/${rollingTag}`;

    await prepareBinaryReleaseAssets({
      repoRoot,
      productId: productSpec.id,
      channel,
      version,
      assetsBaseUrl,
      commitSha: targetSha,
      workflowRunId: String(process.env.GITHUB_RUN_ID ?? ''),
      dryRun: opts.dryRun,
      env: {
        HAPPIER_EMBEDDED_POLICY_ENV: process.env.HAPPIER_EMBEDDED_POLICY_ENV ?? embeddedPolicy,
      },
    });

    const artifactsDir = withinRepo(repoRoot, productSpec.artifactsDir);

    for (const release of [
      {
        tag: rollingTag,
        title: rollingTitle,
        notes,
        rollingTag: 'true',
        generateNotes: 'false',
      },
      {
        tag: versionTag,
        title: versionTitle,
        notes: versionNotes,
        rollingTag: 'false',
        generateNotes: 'true',
      },
    ]) {
      run(
        opts,
        process.execPath,
        [
          GITHUB_RELEASE_SCRIPT_RELATIVE_PATH,
          '--tag',
          release.tag,
          '--title',
          release.title,
          '--target-sha',
          targetSha,
          '--prerelease',
          prerelease,
          '--rolling-tag',
          release.rollingTag,
          '--generate-notes',
          release.generateNotes,
          '--notes',
          release.notes,
          '--assets-dir',
          path.relative(repoRoot, artifactsDir),
          '--clobber',
          'true',
          '--prune-assets',
          'true',
          '--release-message',
          releaseMessage,
          ...(opts.dryRun ? ['--dry-run'] : []),
        ],
        { cwd: repoRoot },
      );
    }

    if (!opts.dryRun && productSpec.id === 'cli') {
      console.log(`[pipeline] published GitHub rolling release: ${rollingTag}`);
      console.log(`[pipeline] published GitHub versioned release: ${versionTag}`);
      console.log(`[pipeline] note: GitHub may not update 'Published' timestamps for rolling releases; verify assets on tag '${rollingTag}'.`);
    }
  } finally {
    if (restoreVersion) {
      restoreVersion();
    }
  }
}

const isDirectEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectEntry) {
  publishBinaryReleaseMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
