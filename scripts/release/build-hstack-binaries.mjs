#!/usr/bin/env node

import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  CLI_STACK_TARGETS,
  commandExists,
  compileBunBinary,
  ensureFileExists,
  normalizeChannel,
  packageTargetBinary,
  parseArgs,
  parseCsv,
  readVersionFromPackageJson,
  resolveRepoRoot,
  resolveTargets,
  maybeSignFile,
  writeChecksumsFile,
} from './lib/binary_release.mjs';

async function main() {
  const repoRoot = resolveRepoRoot();
  const { kv } = parseArgs(process.argv.slice(2));

  if (!commandExists('bun')) {
    throw new Error('[release] bun is required to build binaries');
  }

  const channel = normalizeChannel(kv.get('--channel'));
  const version = String(kv.get('--version') ?? '').trim()
    || readVersionFromPackageJson(join(repoRoot, 'apps', 'stack', 'package.json'));
  const outDir = join(repoRoot, 'dist', 'release-assets', 'stack');
  // IMPORTANT: build scripts are invoked by multiple integration tests in parallel.
  // Never share a single temp directory across invocations, or concurrent builds will race on rm/mkdir.
  const tempBaseDir = join(repoRoot, 'dist', 'release-assets', '.tmp-stack-binaries');
  const tempDir = join(tempBaseDir, `build-${process.pid}-${randomUUID()}`);
  const entrypoint = String(kv.get('--entrypoint') ?? '').trim()
    || join(repoRoot, 'apps', 'stack', 'scripts', 'self_host.mjs');
  const externals = parseCsv(kv.get('--externals') ?? process.env.HAPPIER_STACK_BUN_EXTERNALS ?? '');
  const targets = resolveTargets({
    availableTargets: CLI_STACK_TARGETS,
    requested: kv.get('--targets'),
  });

  await ensureFileExists(entrypoint);
  await mkdir(tempBaseDir, { recursive: true });
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const artifacts = [];
  for (const target of targets) {
    const compiledPath = join(tempDir, `hstack-${target.os}-${target.arch}${target.exeExt}`);
    await compileBunBinary({
      entrypoint,
      bunTarget: target.bunTarget,
      outfile: compiledPath,
      cwd: repoRoot,
      externals,
    });
    const artifact = await packageTargetBinary({
      product: 'hstack',
      version,
      target,
      executableName: 'hstack',
      buildTempDir: tempDir,
      outDir,
      compiledPath,
    });
    artifacts.push(artifact);
  }

  const checksumsPath = await writeChecksumsFile({
    product: 'hstack',
    version,
    artifacts,
    outDir,
  });
  const signaturePath = await maybeSignFile({
    path: checksumsPath,
    trustedComment: `hstack ${version} ${channel}`,
  });

  // Best-effort cleanup to avoid unbounded temp build directories.
  await rm(tempDir, { recursive: true, force: true });

  const output = {
    product: 'hstack',
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
