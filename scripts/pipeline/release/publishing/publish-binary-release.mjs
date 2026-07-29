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
} from '../lib/public-release-rings.mjs';
import {
  resolveRollingPublishVersion,
  resolveRollingRecoveryVersion,
} from '../lib/rolling-version-allocation.mjs';
import { withCurrentVersionLine } from '../lib/rolling-release-notes.mjs';
import { resolveGitHubRepoSlug } from '../../github/resolve-github-repo-slug.mjs';
import { prepareBinaryReleaseAssets } from './prepare-binary-assets.mjs';
import { getBinaryPublishProductSpec } from './product-specs.mjs';

const GITHUB_RELEASE_SCRIPT_RELATIVE_PATH = 'scripts/pipeline/github/publish-release.mjs';
const ROLLING_PROMOTION_SCRIPT_RELATIVE_PATH = 'scripts/pipeline/github/promote-rolling-release.mjs';
const INSTALLER_SYNC_SCRIPT_RELATIVE_PATH = 'scripts/pipeline/release/sync-installers.mjs';
const MINISIGN_BOOTSTRAP_RELATIVE_PATH = '.github/actions/bootstrap-minisign/bootstrap-minisign.sh';
const RELEASE_PUBLIC_KEY_RELATIVE_PATH = 'scripts/release/installers/happier-release.pub';

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
  const { prepareMinisignSecretKeyFile } = await import('../lib/minisign-secret-key.mjs');
  const prepared = await prepareMinisignSecretKeyFile(keyRaw);
  if (prepared.temp) {
    await rm(prepared.cleanupPath ?? prepared.path, { recursive: true, force: true });
  }
}

/**
 * @param {ReturnType<typeof getBinaryPublishProductSpec>} productSpec
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 * @param {string} baseVersion
 * @param {{ repoRoot: string; explicitVersion?: string; dryRun: boolean }} opts
 */
async function computePublishVersion(productSpec, channel, baseVersion, opts) {
  return (
    await resolveRollingPublishVersion({
      repoRoot: opts.repoRoot,
      productId: productSpec.id,
      channel,
      baseVersion,
      explicitVersion: opts.explicitVersion,
      publishSurface: 'github',
      dryRun: opts.dryRun,
      env: process.env,
    })
  ).version;
}

/**
 * @param {string[]} argv
 */
export function parsePublishBinaryReleaseArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      product: { type: 'string' },
      channel: { type: 'string' },
      'allow-stable': { type: 'string', default: 'false' },
      'release-message': { type: 'string', default: '' },
      'run-contracts': { type: 'string', default: 'auto' },
      'check-installers': { type: 'string', default: 'true' },
      version: { type: 'string', default: '' },
      phase: { type: 'string', default: 'publish' },
      'authorized-sha': { type: 'string', default: '' },
      'base-version': { type: 'string', default: '' },
      'prepared-artifacts': { type: 'boolean', default: false },
      'resolve-version-only': { type: 'boolean', default: false },
      'github-output': { type: 'string', default: '' },
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
  const explicitVersion = String(values.version ?? '').trim();
  const phase = String(values.phase ?? 'publish').trim();
  if (!['publish', 'promote-rolling'].includes(phase)) {
    throw new Error('--phase must be publish|promote-rolling');
  }
  if (phase === 'promote-rolling' && !explicitVersion) {
    throw new Error('--version is required for same-version rolling promotion');
  }

  const releaseRing = getPublicReleaseRingEntry(channel);
  const embeddedPolicy = resolveEmbeddedPolicyForChannel(channel);
  const version = phase === 'promote-rolling'
    ? (
        await resolveRollingRecoveryVersion({
          repoRoot,
          productId: productSpec.id,
          channel,
          explicitVersion,
          env: process.env,
        })
      ).version
    : await computePublishVersion(
        productSpec,
        channel,
        String(values['base-version'] ?? '').trim() || readBaseVersion(repoRoot, productSpec),
        {
          repoRoot,
          explicitVersion,
          dryRun: opts.dryRun,
        },
      );
  if (values['resolve-version-only'] === true) {
    const githubOutputPath = String(values['github-output'] ?? '').trim();
    if (githubOutputPath) {
      fs.appendFileSync(githubOutputPath, `version=${version}\n`, 'utf8');
    }
    const output = {
      product: productSpec.id,
      channel,
      version,
    };
    console.log(JSON.stringify(output, null, 2));
    return output;
  }
  const rollingTag = `${productSpec.rollingTagPrefix}-${resolveRollingReleaseTagSuffix(channel)}`;
  const rollingTitle = `${productSpec.releaseTitleBase} ${resolveRollingReleaseLabel(channel)}`;
  const prerelease = resolveRollingPrerelease(channel);
  const notesBase = `Rolling ${releaseRing.publicLabel} ${productSpec.rollingNotesSubject}.`;
  const notes = withCurrentVersionLine(notesBase, version);
  const versionTag = `${productSpec.versionTagPrefix}${version}`;
  const versionTitle = `${productSpec.releaseTitleBase} v${version}`;
  const versionNotes = `${productSpec.versionNotesSubject} ${releaseRing.publicLabel} build v${version}.`;
  const authorizedSha = String(values['authorized-sha'] ?? '').trim().toLowerCase();
  const targetSha = phase === 'promote-rolling'
    ? authorizedSha
    : authorizedSha || run(opts, 'git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).trim() || 'UNKNOWN_SHA';
  if (authorizedSha && !/^[a-f0-9]{40}$/.test(authorizedSha)) {
    throw new Error('--authorized-sha must be a full 40-character commit id');
  }
  if (phase === 'promote-rolling' && !/^[a-f0-9]{40}$/.test(targetSha)) {
    throw new Error('--authorized-sha must be a full 40-character commit id for rolling recovery');
  }

  console.log(
    `[pipeline] ${productSpec.pipelineLabel}: channel=${formatPublicReleaseChannel(channel)} tag=${rollingTag}${
      productSpec.id === 'server' ? ` version=${version}` : ''
    }`,
  );

  if (phase !== 'promote-rolling') await preflightMinisignKey(productSpec, opts);

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

  if (phase === 'promote-rolling') {
    const githubOutputPath = String(values['github-output'] ?? '').trim();
    if (githubOutputPath) fs.appendFileSync(githubOutputPath, `version=${version}\n`, 'utf8');
    const repoSlug = resolveGitHubRepoSlug({ repoRoot, env: process.env });
    if (!repoSlug) throw new Error('Unable to resolve GitHub repo slug for rolling promotion.');
    run(opts, process.execPath, [
      ROLLING_PROMOTION_SCRIPT_RELATIVE_PATH,
      '--source-tag', versionTag,
      '--rolling-tag', rollingTag,
      '--title', rollingTitle,
      '--target-sha', targetSha,
      '--prerelease', prerelease,
      '--notes', notes,
      '--release-message', releaseMessage,
      '--repo', repoSlug,
      '--public-key', RELEASE_PUBLIC_KEY_RELATIVE_PATH,
      ...(opts.dryRun ? ['--dry-run'] : []),
    ], { cwd: repoRoot });
    return { product: productSpec.id, channel, version };
  }

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
    const assetsBaseUrl = `https://github.com/${repoSlug}/releases/download/${versionTag}`;

    await prepareBinaryReleaseAssets({
      repoRoot,
      productId: productSpec.id,
      channel,
      version,
      assetsBaseUrl,
      commitSha: targetSha,
      workflowRunId: String(process.env.GITHUB_RUN_ID ?? ''),
      preparedArtifacts: values['prepared-artifacts'] === true,
      dryRun: opts.dryRun,
      env: {
        HAPPIER_EMBEDDED_POLICY_ENV: process.env.HAPPIER_EMBEDDED_POLICY_ENV ?? embeddedPolicy,
      },
    });

    const artifactsDir = withinRepo(repoRoot, productSpec.artifactsDir);

    run(opts, process.execPath, [
      GITHUB_RELEASE_SCRIPT_RELATIVE_PATH,
      '--tag', versionTag,
      '--title', versionTitle,
      '--target-sha', targetSha,
      '--prerelease', prerelease,
      '--rolling-tag', 'false',
      '--generate-notes', 'true',
      '--notes', versionNotes,
      '--assets-dir', path.relative(repoRoot, artifactsDir),
      '--clobber', 'false',
      '--prune-assets', 'false',
      '--release-message', releaseMessage,
      ...(opts.dryRun ? ['--dry-run'] : []),
    ], { cwd: repoRoot });

    run(opts, process.execPath, [
      ROLLING_PROMOTION_SCRIPT_RELATIVE_PATH,
      '--source-tag', versionTag,
      '--rolling-tag', rollingTag,
      '--title', rollingTitle,
      '--target-sha', targetSha,
      '--prerelease', prerelease,
      '--notes', notes,
      '--release-message', releaseMessage,
      '--repo', repoSlug,
      '--public-key', RELEASE_PUBLIC_KEY_RELATIVE_PATH,
      ...(opts.dryRun ? ['--dry-run'] : []),
    ], { cwd: repoRoot });

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
