// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseArtifactFilename } from '../lib/manifests.mjs';
import { normalizePublicReleaseChannel } from '../lib/public-release-rings.mjs';
import { resolveArtifactVerifyExecution, resolveArtifactVerifyTarget } from './artifact-verify-target.mjs';
import { getBinaryPublishProductSpec } from './product-specs.mjs';

const MANIFEST_PUBLISH_SCRIPT_RELATIVE_PATH = 'scripts/pipeline/release/publish-manifests.mjs';

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
 * @param {{ cwd?: string; env?: Record<string, string | undefined>; stdio?: 'inherit' | 'pipe' }} [extra]
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
 * Finalize native target archives produced by separate platform jobs.
 *
 * The publish job must never silently sign a partial, stale, or mixed-version matrix.
 *
 * @param {{
 *   artifactsDir: string;
 *   productSpec: ReturnType<typeof getBinaryPublishProductSpec>;
 *   channel: string;
 *   version: string;
 *   targets?: ReadonlyArray<Readonly<{ os: string; arch: string }>>;
 *   writeChecksums?: (params: {
 *     product: string;
 *     version: string;
 *     artifacts: ReadonlyArray<Readonly<{ name: string; path: string; os: string; arch: string }>>;
 *     outDir: string;
 *   }) => Promise<string>;
 *   signFile?: (params: { path: string; trustedComment?: string }) => Promise<string | null>;
 * }} params
 */
export async function finalizePreparedBinaryArtifacts(params) {
  const artifactsDir = path.resolve(params.artifactsDir);
  const channel = normalizePublicReleaseChannel(params.channel);
  if (!channel) {
    throw new Error('prepared binary artifact channel must be stable|preview|dev');
  }
  const version = String(params.version ?? '').trim();
  if (!version) {
    throw new Error('prepared binary artifacts require a version');
  }

  let targets = params.targets;
  let writeChecksums = params.writeChecksums;
  let signFile = params.signFile;
  if (!targets || !writeChecksums || !signFile) {
    const binaryRelease = await import('../lib/binary-release.mjs');
    targets ??= params.productSpec.id === 'server'
      ? binaryRelease.SERVER_TARGETS
      : binaryRelease.CLI_STACK_TARGETS;
    writeChecksums ??= binaryRelease.writeChecksumsFile;
    signFile ??= binaryRelease.maybeSignFile;
  }
  const expectedArtifacts = targets.map((target) => ({
    ...target,
    name: `${params.productSpec.manifestProduct}-v${version}-${target.os}-${target.arch}.tar.gz`,
  }));
  const expectedNames = new Set(expectedArtifacts.map((artifact) => artifact.name));
  const archiveNames = (await readdir(artifactsDir))
    .filter((name) => name.endsWith('.tar.gz'))
    .sort();

  for (const name of archiveNames) {
    const parsed = parseArtifactFilename(name);
    if (!parsed || !expectedNames.has(name)) {
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

  const artifacts = expectedArtifacts.map((artifact) => ({
    name: artifact.name,
    path: path.join(artifactsDir, artifact.name),
    os: artifact.os,
    arch: artifact.arch,
  }));
  const evidenceSuffix = params.productSpec.notarizationEvidenceSuffix;
  const evidenceNames = (await readdir(artifactsDir))
    .filter((name) => name.endsWith(`.${evidenceSuffix}.json`))
    .sort();
  const expectedEvidenceNames = [
    `darwin-arm64.${evidenceSuffix}.json`,
    `darwin-x64.${evidenceSuffix}.json`,
  ];
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
  artifacts.push(...evidenceNames.map((name) => ({
    name,
    path: path.join(artifactsDir, name),
    os: 'darwin',
    arch: name.includes('arm64') ? 'arm64' : 'x64',
  })));
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
  return {
    artifacts,
    checksumsPath,
    signaturePath,
  };
}

/**
 * @param {{
 *   repoRoot: string;
 *   productId: string;
 *   channel: string;
 *   version: string;
 *   assetsBaseUrl: string;
 *   commitSha: string;
 *   buildWorkflowRunId?: string;
 *   publicationWorkflowRunId?: string;
 *   workflowRunId?: string;
 *   skipSmoke?: boolean;
 *   preparedArtifacts?: boolean;
 *   finalizedArtifacts?: boolean;
 *   dryRun?: boolean;
 *   env?: Record<string, string | undefined>;
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
  if (params.preparedArtifacts === true) {
    const artifactsDir = withinRepo(repoRoot, productSpec.artifactsDir);
    if (params.finalizedArtifacts === true) {
      console.log(
        `${opts.dryRun ? '[dry-run]' : '[pipeline]'} preserve authenticated finalized artifacts under ${productSpec.artifactsDir}`,
      );
    } else if (!opts.dryRun || params.finalizePrepared) {
      await (params.finalizePrepared ?? finalizePreparedBinaryArtifacts)({
        artifactsDir,
        productSpec,
        channel,
        version,
      });
    } else {
      console.log(`[dry-run] would finalize prepared artifacts under ${productSpec.artifactsDir}`);
    }
  } else {
    await ensureCleanBinaryArtifactsDir(repoRoot, productSpec, opts);
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
      '--build-workflow-run-id',
      String(params.buildWorkflowRunId ?? params.workflowRunId ?? ''),
      '--publication-workflow-run-id',
      String(params.publicationWorkflowRunId ?? params.workflowRunId ?? ''),
    ],
    { cwd: repoRoot },
  );

  const target = resolveArtifactVerifyTarget({
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
    for (const expectedPath of target.preflightPaths) {
      if (!existsSync(expectedPath)) {
        throw new Error(`Missing expected artifact: ${path.relative(repoRoot, expectedPath)}`);
      }
    }
  } else {
    console.log(`[dry-run] would verify artifacts under ${path.relative(repoRoot, target.artifactsDir)}`);
  }

  const execution = resolveArtifactVerifyExecution({
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
    execution.args.push('--require-all-artifacts-checksummed', '--require-signature');
  }
  runBinaryAssetStep(opts, execution.command, execution.args, {
    cwd: execution.cwd,
  });
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
      'build-workflow-run-id': { type: 'string', default: '' },
      'publication-workflow-run-id': { type: 'string', default: '' },
      'finalize-prepared-only': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  }).values;
}

/**
 * @param {{
 *   argv?: string[];
 *   cwd?: string;
 *   finalizePrepared?: typeof finalizePreparedBinaryArtifacts;
 * }} [options]
 */
export async function prepareBinaryAssetsMain(options = {}) {
  const repoRoot = path.resolve(options.cwd ?? process.cwd());
  const values = parsePrepareBinaryAssetsArgs(options.argv ?? process.argv.slice(2));
  if (values['finalize-prepared-only'] === true) {
    if (values['dry-run'] === true) {
      throw new Error('--finalize-prepared-only cannot be combined with --dry-run');
    }
    const artifactsDir = String(values['artifacts-dir'] ?? '').trim();
    if (!artifactsDir) {
      throw new Error('--artifacts-dir is required with --finalize-prepared-only');
    }
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
    buildWorkflowRunId: String(values['build-workflow-run-id'] ?? ''),
    publicationWorkflowRunId: String(values['publication-workflow-run-id'] ?? ''),
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
