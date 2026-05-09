#!/usr/bin/env node

// @ts-check

import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CLI_STACK_TARGETS,
  buildCliBinaryArtifactPayload,
  normalizeChannel,
  packagePreparedTargetBinary,
  parseArgs,
  parseCsv,
  readVersionFromPackageJson,
  resolveRepoRoot,
  resolveTargets,
  maybeSignFile,
  writeChecksumsFile,
} from './lib/binary-release.mjs';

export function resolveReleaseTempCleanupTimeoutMs(env = process.env) {
  const raw = String(env.HAPPIER_RELEASE_TEMP_CLEANUP_TIMEOUT_MS ?? '').trim();
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 30_000;
  return Math.min(300_000, Math.max(1_000, parsed));
}

export async function cleanupTempDirBestEffort({
  tempDir,
  timeoutMs = resolveReleaseTempCleanupTimeoutMs(process.env),
  rmImpl = rm,
  logger = console,
}) {
  let cleanupCompleted = false;
  await Promise.race([
    rmImpl(tempDir, { recursive: true, force: true }).then(() => {
      cleanupCompleted = true;
    }),
    delay(timeoutMs),
  ]);

  if (!cleanupCompleted) {
    logger.warn(`[release] temp cleanup timed out after ${timeoutMs}ms: ${tempDir}`);
    return { timedOut: true };
  }

  return { timedOut: false };
}

async function main() {
  const repoRoot = resolveRepoRoot();
  const { kv } = parseArgs(process.argv.slice(2));

  const channel = normalizeChannel(kv.get('--channel'));
  const version = String(kv.get('--version') ?? '').trim()
    || readVersionFromPackageJson(join(repoRoot, 'apps', 'cli', 'package.json'));
  const outDir = join(repoRoot, 'dist', 'release-assets', 'cli');
  // IMPORTANT: build scripts are invoked by multiple integration tests in parallel.
  // Never share a single temp directory across invocations, or concurrent builds will race on rm/mkdir.
  const tempBaseDir = join(repoRoot, 'dist', 'release-assets', '.tmp-cli-binaries');
  const tempDir = join(tempBaseDir, `build-${process.pid}-${randomUUID()}`);
  const externals = parseCsv(kv.get('--externals') ?? process.env.HAPPIER_CLI_BUN_EXTERNALS ?? '');
  const targets = resolveTargets({
    availableTargets: CLI_STACK_TARGETS,
    requested: kv.get('--targets'),
  });
  await mkdir(tempBaseDir, { recursive: true });
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const artifacts = [];
  for (const target of targets) {
    const stageDir = join(tempDir, `happier-v${version}-${target.os}-${target.arch}`);
    await buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir: stageDir,
      target,
      externals,
    });
    const artifact = await packagePreparedTargetBinary({
      product: 'happier',
      version,
      target,
      stageDir,
      outDir,
    });
    artifacts.push(artifact);
  }

  const checksumsPath = await writeChecksumsFile({
    product: 'happier',
    version,
    artifacts,
    outDir,
  });
  const signaturePath = await maybeSignFile({
    path: checksumsPath,
    trustedComment: `happier ${version} ${channel}`,
  });

  // Best-effort cleanup to avoid unbounded temp build directories.
  await cleanupTempDirBestEffort({ tempDir });

  const output = {
    product: 'happier',
    channel,
    version,
    outDir,
    artifacts: artifacts.map((artifact) => artifact.name),
    checksums: checksumsPath,
    signature: signaturePath,
  };
  console.log(JSON.stringify(output, null, 2));
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  if (!arg) return false;
  return arg.endsWith('/scripts/pipeline/release/build-cli-binaries.mjs')
    || arg.endsWith('\\scripts\\pipeline\\release\\build-cli-binaries.mjs');
})();

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
