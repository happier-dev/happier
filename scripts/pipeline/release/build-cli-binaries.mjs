#!/usr/bin/env node

// @ts-check

import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  CLI_STACK_TARGETS,
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
import { buildCliBinaryArtifactPayload } from '@happier-dev/cli-common/componentArtifacts';

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
  await rm(tempDir, { recursive: true, force: true });

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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
