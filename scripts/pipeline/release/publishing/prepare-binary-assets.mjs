// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseArtifactFilename } from '../lib/manifests.mjs';
import { normalizePublicReleaseChannel } from '../lib/public-release-rings.mjs';
import * as runnerPackaging from '../lib/runner-packaging.mjs';
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
      : params.productSpec.id === 'runner'
        // Publication eligibility is owned once by the Runner packaging owner;
        // a build flag must never add a target whose native release admission
        // has not been implemented. Availability remains publication + feature owned.
        ? runnerPackaging.resolveRunnerPublicationEligibleBinaryTargets(binaryRelease.CLI_STACK_TARGETS)
        : binaryRelease.CLI_STACK_TARGETS;
    writeChecksums ??= binaryRelease.writeChecksumsFile;
    signFile ??= binaryRelease.maybeSignFile;
  }
  // Generated channel manifests join the signed envelope: candidate inspection rejects any unsigned asset.
  const expectedManifestNames = params.manifestsDir
    ? [...targets.map((target) => `${target.os}-${target.arch}.json`), 'latest.json'].sort()
    : [];
  if (params.manifestsDir) {
    const mainChecksumsPath = path.join(artifactsDir, `checksums-${params.productSpec.manifestProduct}-v${version}.txt`);
    await Promise.all([rm(mainChecksumsPath, { force: true }), rm(`${mainChecksumsPath}.minisig`, { force: true })]);
    const manifestsDir = path.resolve(params.manifestsDir);
    const manifestNames = (await readdir(manifestsDir)).sort();
    if (manifestNames.length !== expectedManifestNames.length
      || manifestNames.some((name, index) => name !== expectedManifestNames[index])) {
      throw new Error(`unexpected generated manifest set for ${params.productSpec.id} ${version}`);
    }
    for (const name of manifestNames) {
      const sourcePath = path.join(manifestsDir, name);
      const metadata = await lstat(sourcePath);
      if (!metadata.isFile() || metadata.size < 1) throw new Error(`generated manifest must be a regular non-empty file: ${name}`);
      await copyFile(sourcePath, path.join(artifactsDir, name));
    }
    if (params.manifestsRoot) {
      const relativeRoot = path.relative(artifactsDir, path.resolve(params.manifestsRoot));
      if (!relativeRoot || path.isAbsolute(relativeRoot) || relativeRoot === '..' || relativeRoot.startsWith(`..${path.sep}`)) {
        throw new Error('generated manifests root must be a child of the prepared artifacts directory');
      }
      await rm(path.resolve(params.manifestsRoot), { recursive: true, force: true });
    }
  }
  const archiveExtension = params.productSpec.id === 'runner' ? 'zip' : 'tar.gz';
  const componentProducts = params.productSpec.optionalComponentProducts ?? [];
  const products = [params.productSpec.manifestProduct, ...componentProducts];
  const expectedArtifacts = products.flatMap((product) => targets.map((target) => ({
    ...target,
    name: `${product}-v${version}-${target.os}-${target.arch}.${archiveExtension}`,
  })));
  const expectedNames = new Set(expectedArtifacts.map((artifact) => artifact.name));
  const archiveNames = (await readdir(artifactsDir))
    .filter((name) => name.endsWith('.tar.gz') || name.endsWith('.zip'))
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
  if (params.productSpec.id === 'runner') {
    const { verifyReleaseArchiveAdmission } = await import('../verify-artifacts.mjs');
    for (const artifact of artifacts) {
      const entries = await verifyReleaseArchiveAdmission({ archivePath: artifact.path, archiveName: artifact.name });
      const archive = await stat(artifact.path);
      artifact.archiveMetadata = { sizeBytes: archive.size, entries };
    }
  }
  const evidenceSuffix = params.productSpec.notarizationEvidenceSuffix;
  const evidenceSuffixes = [evidenceSuffix, ...componentProducts];
  const evidenceNames = (await readdir(artifactsDir))
    .filter((name) => evidenceSuffixes.some((suffix) => name.endsWith(`.${suffix}.json`)))
    .sort();
  const expectedEvidenceNames = targets
    .filter((target) => target.os === 'darwin')
    .flatMap((target) => evidenceSuffixes.map((suffix) => `darwin-${target.arch}.${suffix}.json`))
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
  artifacts.push(...evidenceNames.map((name) => ({
    name,
    path: path.join(artifactsDir, name),
    os: 'darwin',
    arch: name.includes('arm64') ? 'arm64' : 'x64',
  })));
  artifacts.push(...expectedManifestNames.map((name) => ({
    name,
    path: path.join(artifactsDir, name),
    os: 'manifest',
    arch: name === 'latest.json' ? 'latest' : name.slice(0, -'.json'.length),
  })));
  for (const product of componentProducts) {
    const componentChecksumsPath = await writeChecksums({
      product, version, outDir: artifactsDir,
      artifacts: artifacts.filter((artifact) => artifact.name.startsWith(`${product}-v`)
        || artifact.name.endsWith(`.${product}.json`)),
    });
    const componentSignaturePath = await signFile({
      path: componentChecksumsPath, trustedComment: `${product} ${version} ${channel}`,
    });
    if (!componentSignaturePath) throw new Error(`prepared ${product} artifacts require a minisign signature`);
    for (const assetPath of [componentChecksumsPath, componentSignaturePath]) {
      artifacts.push({ name: path.basename(assetPath), path: assetPath, os: 'manifest', arch: product });
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

  // A prepared (not yet authenticated) matrix is resealed with its generated channel manifests.
  const manifestsInArtifactsRoot = params.preparedArtifacts === true && params.finalizedArtifacts !== true;
  if (manifestsInArtifactsRoot) {
    if (!opts.dryRun || params.finalizePrepared) {
      const manifestsRoot = withinRepo(repoRoot, productSpec.manifestOutDir);
      await (params.finalizePrepared ?? finalizePreparedBinaryArtifacts)({
        artifactsDir: withinRepo(repoRoot, productSpec.artifactsDir),
        manifestsRoot,
        manifestsDir: path.join(manifestsRoot, 'v1', productSpec.manifestProduct, channel),
        productSpec,
        channel,
        version,
      });
    } else {
      console.log(`[dry-run] would reseal prepared artifacts with generated manifests under ${productSpec.artifactsDir}`);
    }
  }

  const target = resolveArtifactVerifyTarget({
    repoRoot,
    source: { kind: 'local-build', ref: productSpec.artifactsDir },
    options: {
      product: productSpec.id,
      version,
      releaseChannel: channel,
      manifestsInArtifactsRoot,
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
      manifestsInArtifactsRoot,
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
