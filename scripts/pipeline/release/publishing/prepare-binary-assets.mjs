// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

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
  await ensureCleanBinaryArtifactsDir(repoRoot, productSpec, opts);

  runBinaryAssetStep(opts, process.execPath, [productSpec.buildScriptPath, '--channel', channel, '--version', version], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...params.env,
    },
  });

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
      'assets-base-url': { type: 'string' },
      'commit-sha': { type: 'string' },
      'workflow-run-id': { type: 'string', default: '' },
      'skip-smoke': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  }).values;
}

/**
 * @param {{ argv?: string[]; cwd?: string }} [options]
 */
export async function prepareBinaryAssetsMain(options = {}) {
  const repoRoot = path.resolve(options.cwd ?? process.cwd());
  const values = parsePrepareBinaryAssetsArgs(options.argv ?? process.argv.slice(2));
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
