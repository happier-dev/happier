// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { normalizePublicReleaseChannel } from '../lib/public-release-rings.mjs';
import { parseArtifactFilename } from '../lib/manifests.mjs';
import { writeChecksumsFile } from '../lib/release-files.mjs';
import { resolveArtifactVerifyExecution, resolveArtifactVerifyTarget } from './artifact-verify-target.mjs';
import { getBinaryPublishProductSpec } from './product-specs.mjs';
import { finalizeServerRuntimeCandidate } from './server-runtime-candidate.mjs';
import { maybeSignFile } from '../lib/minisign-signing.mjs';

const MANIFEST_PUBLISH_SCRIPT_RELATIVE_PATH = 'scripts/pipeline/release/publish-manifests.mjs';

/**
 * @param {string} repoRoot
 * @param {string} rel
 */
function withinRepo(repoRoot, rel) {
  return path.resolve(repoRoot, rel);
}

/**
 * @param {string} packageJsonPath
 * @param {string} nextVersion
 * @returns {() => void}
 */
function patchPackageVersion(packageJsonPath, nextVersion) {
  const raw = readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const previousVersion = String(parsed.version ?? '').trim();
  if (!previousVersion) {
    throw new Error(`package.json missing version: ${packageJsonPath}`);
  }
  parsed.version = nextVersion;
  writeFileSync(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return () => {
    writeFileSync(packageJsonPath, raw, 'utf8');
  };
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string>; stdio?: 'inherit' | 'pipe' }} [extra]
 * @returns {string}
 */
export function runBinaryAssetStep(opts, cmd, args, extra) {
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const printable = `${cmd} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
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
 * publish-release uploads every file under --assets-dir. Make sure we start from a clean directory so
 * stale artifacts from previous local runs cannot leak into release assets.
 * @param {string} repoRoot
 * @param {ReturnType<typeof getBinaryPublishProductSpec>} productSpec
 * @param {{ dryRun: boolean }} opts
 */
export async function ensureCleanBinaryArtifactsDir(repoRoot, productSpec, opts) {
  const abs = withinRepo(repoRoot, productSpec.artifactsDir);
  const prefix = opts.dryRun ? '[dry-run]' : '[pipeline]';
  console.log(`${prefix} clean artifacts dir: ${productSpec.artifactsDir}`);
  if (opts.dryRun) return;
  await rm(abs, { recursive: true, force: true });
  await mkdir(abs, { recursive: true });
}

/**
 * Canonical admission and signing owner for a complete native artifact matrix.
 * Both Darwin notarization records are release artifacts and are covered by the
 * same checksum/minisign envelope as the five native archives.
 */
export async function finalizePreparedBinaryArtifacts(params) {
  const artifactsDir = path.resolve(params.artifactsDir);
  const channel = normalizePublicReleaseChannel(params.channel);
  if (!channel) throw new Error('prepared binary artifact channel must be stable|preview|dev');
  const version = String(params.version ?? '').trim();
  if (!version) throw new Error('prepared binary artifacts require a version');

  const targets = params.targets ?? params.productSpec.artifactTargets;
  const writeChecksums = params.writeChecksums ?? writeChecksumsFile;
  const signFile = params.signFile ?? maybeSignFile;

  const expectedArtifacts = targets.map((target) => ({
    ...target,
    name: `${params.productSpec.manifestProduct}-v${version}-${target.os}-${target.arch}.tar.gz`,
  }));
  const preparedNames = (await readdir(artifactsDir)).sort();
  const expectedNames = new Set(expectedArtifacts.map((artifact) => artifact.name));
  const archiveNames = preparedNames
    .filter((name) => name.endsWith('.tar.gz'))
    .sort();
  for (const name of archiveNames) {
    if (!parseArtifactFilename(name) || !expectedNames.has(name)) {
      throw new Error(`unexpected prepared artifact for ${params.productSpec.id} ${version}: ${name}`);
    }
  }
  for (const artifact of expectedArtifacts) {
    if (!archiveNames.includes(artifact.name)) {
      throw new Error(
        `missing prepared artifact for ${params.productSpec.id} ${version}: ${artifact.os}-${artifact.arch} (${artifact.name})`,
      );
    }
  }

  const evidenceSuffix = params.productSpec.notarizationEvidenceSuffix;
  const expectedEvidenceNames = [
    `darwin-arm64.${evidenceSuffix}.json`,
    `darwin-x64.${evidenceSuffix}.json`,
  ];
  const evidenceNames = preparedNames
    .filter((name) => name.endsWith(`.${evidenceSuffix}.json`))
    .sort();
  const missingEvidenceNames = expectedEvidenceNames.filter((name) => !evidenceNames.includes(name));
  if (missingEvidenceNames.length > 0) {
    throw new Error(
      `missing prepared Darwin notarization evidence for ${params.productSpec.id} ${version}: ${missingEvidenceNames.join(', ')}`,
    );
  }
  if (
    evidenceNames.length !== expectedEvidenceNames.length
    || evidenceNames.some((name, index) => name !== expectedEvidenceNames[index])
  ) {
    throw new Error(`unexpected prepared evidence set for ${params.productSpec.id} ${version}`);
  }
  const admittedNames = new Set([...expectedNames, ...expectedEvidenceNames]);
  const unexpectedNames = preparedNames.filter((name) => !admittedNames.has(name));
  if (unexpectedNames.length > 0) {
    throw new Error(
      `unexpected prepared file for ${params.productSpec.id} ${version}: ${unexpectedNames.join(', ')}`,
    );
  }

  const artifacts = [
    ...expectedArtifacts.map((artifact) => ({
      name: artifact.name,
      path: path.join(artifactsDir, artifact.name),
      os: artifact.os,
      arch: artifact.arch,
    })),
    ...evidenceNames.map((name) => ({
      name,
      path: path.join(artifactsDir, name),
      os: 'darwin',
      arch: name.includes('arm64') ? 'arm64' : 'x64',
    })),
  ];
  for (const artifact of artifacts) {
    const metadata = await lstat(artifact.path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
      throw new Error(`prepared artifact must be a regular non-empty file: ${artifact.name}`);
    }
  }

  const checksumsPath = await writeChecksums({
    product: params.productSpec.manifestProduct,
    version,
    artifacts,
    outDir: artifactsDir,
  });
  const signaturePath = await signFile({
    path: checksumsPath,
    trustedComment: `${params.productSpec.manifestProduct} ${version} ${channel}`,
  });
  if (!signaturePath) {
    throw new Error(`prepared ${params.productSpec.id} artifacts require a minisign signature`);
  }
  return { artifacts, checksumsPath, signaturePath };
}

/**
 * @param {{
 *   repoRoot: string;
 *   productId: string;
 *   channel: string;
 *   version: string;
 *   assetsBaseUrl: string;
 *   commitSha: string;
 *   workflowRunId?: string;
 *   skipSmoke?: boolean;
 *   dryRun?: boolean;
 *   env?: Record<string, string | undefined>;
 *   candidateDir?: string;
 *   authorizedSha?: string;
 *   preparedArtifacts?: boolean;
 *   finalizedArtifacts?: boolean;
 *   finalizePrepared?: typeof finalizePreparedBinaryArtifacts;
 * }} params
 */
export async function prepareBinaryReleaseAssets(params) {
  const repoRoot = path.resolve(params.repoRoot);
  const productSpec = getBinaryPublishProductSpec(params.productId);
  const channel = normalizePublicReleaseChannel(params.channel);
  if (!channel) {
    throw new Error('binary asset preparation channel must be stable|preview|dev');
  }
  const version = String(params.version ?? '').trim();
  if (!version) {
    throw new Error('--version is required');
  }
  const assetsBaseUrl = String(params.assetsBaseUrl ?? '').trim();
  if (!assetsBaseUrl) {
    throw new Error('--assets-base-url is required');
  }
  const commitSha = String(params.commitSha ?? '').trim();
  if (!commitSha) {
    throw new Error('--commit-sha is required');
  }

  const opts = { dryRun: params.dryRun === true };
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

    if (params.preparedArtifacts === true) {
      if (params.finalizedArtifacts === true) {
        console.log(
          `${opts.dryRun ? '[dry-run]' : '[pipeline]'} preserve authenticated finalized artifacts under ${productSpec.artifactsDir}`,
        );
      } else if (!opts.dryRun || params.finalizePrepared) {
        await (params.finalizePrepared ?? finalizePreparedBinaryArtifacts)({
          artifactsDir: withinRepo(repoRoot, productSpec.artifactsDir),
          productSpec,
          channel,
          version,
        });
      } else {
        console.log(`[dry-run] would finalize prepared artifacts under ${productSpec.artifactsDir}`);
      }
    } else {
      await ensureCleanBinaryArtifactsDir(repoRoot, productSpec, opts);
    }

    if (params.preparedArtifacts === true) {
      // The workflow already assembled the exact native matrix in the canonical artifacts directory.
    } else if (params.candidateDir) {
      if (productSpec.id !== 'server') throw new Error('candidate finalization is supported only for server runtime assets');
      if (opts.dryRun) {
        console.log(`[dry-run] validate opaque candidate files from ${params.candidateDir}`);
      } else {
        await finalizeServerRuntimeCandidate({
          candidateDir: params.candidateDir,
          outDir: withinRepo(repoRoot, productSpec.artifactsDir),
          version,
          authorizedSha: String(params.authorizedSha ?? ''),
          sign: async (checksumsPath) => {
            await maybeSignFile({ path: checksumsPath, trustedComment: `happier-server ${version} ${channel}` });
          },
        });
      }
    } else {
      runBinaryAssetStep(opts, process.execPath, [productSpec.buildScriptPath, '--channel', channel, '--version', version], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...params.env,
        },
      });
    }

    runBinaryAssetStep(
      opts,
      process.execPath,
      [
        MANIFEST_PUBLISH_SCRIPT_RELATIVE_PATH,
        `--product=${productSpec.manifestProduct}`,
        '--channel',
        channel,
        '--version',
        version,
        '--artifacts-dir',
        productSpec.artifactsDir,
        '--out-dir',
        productSpec.manifestOutDir,
        '--assets-base-url',
        assetsBaseUrl,
        '--commit-sha',
        commitSha,
        '--workflow-run-id',
        String(params.workflowRunId ?? ''),
      ],
      { cwd: repoRoot },
    );

    const artifactVerifyTarget = resolveArtifactVerifyTarget({
      repoRoot,
      source: { kind: 'local-build', ref: productSpec.artifactsDir },
      options: {
        product: productSpec.id,
        version,
        releaseChannel: channel,
        skipSmoke: params.skipSmoke === true,
      },
    });

    if (!opts.dryRun) {
      for (const expectedPath of artifactVerifyTarget.preflightPaths) {
        if (!existsSync(expectedPath)) {
          throw new Error(`Missing expected artifact: ${path.relative(repoRoot, expectedPath)}`);
        }
      }
    } else {
      console.log(`[dry-run] would verify artifacts under ${path.relative(repoRoot, artifactVerifyTarget.artifactsDir)}`);
    }

    const artifactVerifyExecution = resolveArtifactVerifyExecution({
      repoRoot,
      source: { kind: 'local-build', ref: productSpec.artifactsDir },
      options: {
        product: productSpec.id,
        version,
        releaseChannel: channel,
        skipSmoke: params.skipSmoke === true,
      },
    });
    if (params.finalizedArtifacts === true) {
      artifactVerifyExecution.args.push('--require-all-artifacts-checksummed', '--require-signature');
    }
    runBinaryAssetStep(opts, artifactVerifyExecution.command, artifactVerifyExecution.args, {
      cwd: artifactVerifyExecution.cwd,
    });
  } finally {
    if (restoreVersion) restoreVersion();
  }
}

/**
 * @param {string[]} argv
 */
function parsePrepareBinaryAssetsArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      product: { type: 'string' },
      channel: { type: 'string' },
      version: { type: 'string' },
      'artifacts-dir': { type: 'string', default: '' },
      'assets-base-url': { type: 'string' },
      'commit-sha': { type: 'string' },
      'workflow-run-id': { type: 'string', default: '' },
      'finalize-prepared-only': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  }).values;
}

/**
 * @param {{ argv?: string[]; cwd?: string; finalizePrepared?: typeof finalizePreparedBinaryArtifacts }} [options]
 */
export async function prepareBinaryAssetsMain(options = {}) {
  const repoRoot = path.resolve(options.cwd ?? process.cwd());
  const values = parsePrepareBinaryAssetsArgs(options.argv ?? process.argv.slice(2));
  if (values['finalize-prepared-only'] === true) {
    if (values['dry-run'] === true) {
      throw new Error('--finalize-prepared-only cannot be combined with --dry-run');
    }
    const artifactsDir = String(values['artifacts-dir'] ?? '').trim();
    if (!artifactsDir) throw new Error('--artifacts-dir is required with --finalize-prepared-only');
    await (options.finalizePrepared ?? finalizePreparedBinaryArtifacts)({
      artifactsDir: path.resolve(repoRoot, artifactsDir),
      productSpec: getBinaryPublishProductSpec(String(values.product ?? '')),
      channel: String(values.channel ?? ''),
      version: String(values.version ?? ''),
    });
    return;
  }
  await prepareBinaryReleaseAssets({
    repoRoot,
    productId: String(values.product ?? ''),
    channel: String(values.channel ?? ''),
    version: String(values.version ?? ''),
    assetsBaseUrl: String(values['assets-base-url'] ?? ''),
    commitSha: String(values['commit-sha'] ?? ''),
    workflowRunId: String(values['workflow-run-id'] ?? ''),
    skipSmoke: values['skip-smoke'] === true,
    dryRun: values['dry-run'] === true,
  });
}

const isDirectEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectEntry) {
  prepareBinaryAssetsMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
