// @ts-check

import { resolve } from 'node:path';
import { join } from 'node:path';

import { normalizePublicReleaseChannel } from '../lib/public-release-rings.mjs';
import { getBinaryPublishProductSpec } from './product-specs.mjs';

const DEFAULT_PUBLIC_KEY_PATH = 'scripts/release/installers/happier-release.pub';

/**
 * @typedef {{ kind: string; ref: string } | null} ReleaseValidationSource
 * @typedef {{
 *   checksums?: string;
 *   publicKey?: string;
 *   skipSmoke?: boolean;
 *   product?: string;
 *   version?: string;
 *   releaseChannel?: string;
 *   manifestsInArtifactsRoot?: boolean;
 * }} ArtifactVerifyOptions
 */

/**
 * @param {string} version
 * @returns {'stable' | 'preview' | 'publicdev'}
 */
function inferPublicReleaseChannelFromVersion(version) {
  const raw = String(version ?? '').trim();
  if (raw.includes('-dev.')) return 'publicdev';
  if (raw.includes('-preview.')) return 'preview';
  return 'stable';
}

/**
 * @param {string | undefined} raw
 * @param {string} version
 * @returns {'stable' | 'preview' | 'publicdev'}
 */
export function resolveArtifactVerifyChannel(raw, version) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return inferPublicReleaseChannelFromVersion(version);
  }
  const normalized = normalizePublicReleaseChannel(value);
  if (!normalized) {
    throw new Error('artifact-verify release-channel must be stable|preview|dev');
  }
  return normalized;
}

/**
 * @param {ArtifactVerifyOptions} options
 */
export function buildArtifactVerifyArgs(options = {}) {
  /** @type {string[]} */
  const args = [];
  if (options.checksums) {
    args.push('--checksums', options.checksums);
  }
  if (options.publicKey) {
    args.push('--public-key', options.publicKey);
  }
  if (options.skipSmoke) {
    args.push('--skip-smoke');
  }
  return args;
}

/**
 * @param {{
 *   repoRoot: string;
 *   source: ReleaseValidationSource;
 *   options?: ArtifactVerifyOptions;
 * }} params
 */
export function resolveArtifactVerifyTarget({ repoRoot, source, options = {} }) {
  if (options.product) {
    const version = String(options.version ?? '').trim();
    if (!version) {
      throw new Error('artifact-verify with --product requires --version');
    }
    const spec = getBinaryPublishProductSpec(options.product);
    const channel = resolveArtifactVerifyChannel(options.releaseChannel, version);
    const artifactsDir = resolve(repoRoot, spec.artifactsDir);
    const checksumsPath = resolve(
      repoRoot,
      options.checksums || join(spec.artifactsDir, `checksums-${spec.checksumProductStem}-v${version}.txt`),
    );
    const publicKeyPath = resolve(repoRoot, options.publicKey || DEFAULT_PUBLIC_KEY_PATH);
    return {
      artifactsDir,
      checksumsPath,
      publicKeyPath,
      skipSmoke: options.skipSmoke === true,
      preflightPaths: [
        checksumsPath,
        `${checksumsPath}.minisig`,
        options.manifestsInArtifactsRoot
          ? resolve(artifactsDir, 'latest.json')
          : resolve(repoRoot, spec.manifestOutDir, 'v1', spec.manifestProduct, channel, 'latest.json'),
      ],
    };
  }

  if (!source || source.kind !== 'local-build') {
    throw new Error('artifact-verify currently supports either --source local-build <artifacts-dir> or --product <id> --version <ver>');
  }

  return {
    artifactsDir: resolve(repoRoot, source.ref),
    checksumsPath: options.checksums ? resolve(repoRoot, options.checksums) : undefined,
    publicKeyPath: options.publicKey ? resolve(repoRoot, options.publicKey) : undefined,
    skipSmoke: options.skipSmoke === true,
    preflightPaths: [],
  };
}

/**
 * @param {{
 *   repoRoot: string;
 *   source: ReleaseValidationSource;
 *   options?: ArtifactVerifyOptions;
 * }} params
 */
export function resolveArtifactVerifyExecution({ repoRoot, source, options }) {
  const target = resolveArtifactVerifyTarget({ repoRoot, source, options });
  return {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs'),
      '--artifacts-dir',
      target.artifactsDir,
      ...buildArtifactVerifyArgs({
        checksums: target.checksumsPath,
        publicKey: target.publicKeyPath,
        skipSmoke: target.skipSmoke,
      }),
    ],
    cwd: repoRoot,
  };
}
