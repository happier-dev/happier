#!/usr/bin/env node

import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

import {
  SERVER_TARGETS,
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
    || readVersionFromPackageJson(join(repoRoot, 'apps', 'server', 'package.json'));
  const outDir = join(repoRoot, 'dist', 'release-assets', 'server');
  const tempDir = join(repoRoot, 'dist', 'release-assets', '.tmp-server-binaries');
  const entrypoint = String(kv.get('--entrypoint') ?? '').trim()
    || join(repoRoot, 'apps', 'server', 'sources', 'main.light.ts');
  const externals = parseCsv(kv.get('--externals') ?? process.env.HAPPIER_SERVER_BUN_EXTERNALS ?? 'redis');
  const targets = resolveTargets({
    availableTargets: SERVER_TARGETS,
    requested: kv.get('--targets'),
  });

  await ensureFileExists(entrypoint);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const artifacts = [];
  for (const target of targets) {
    const compiledPath = join(tempDir, `happier-server-${target.os}-${target.arch}${target.exeExt}`);
    await compileBunBinary({
      entrypoint,
      bunTarget: target.bunTarget,
      outfile: compiledPath,
      cwd: repoRoot,
      externals,
    });
    const artifact = await packageTargetBinary({
      product: 'happier-server',
      version,
      target,
      executableName: 'happier-server',
      buildTempDir: tempDir,
      outDir,
      compiledPath,
    });
    artifacts.push(artifact);
  }

  const checksumsPath = await writeChecksumsFile({
    product: 'happier-server',
    version,
    artifacts,
    outDir,
  });
  const signaturePath = await maybeSignFile({
    path: checksumsPath,
    trustedComment: `happier-server ${version} ${channel}`,
  });

  const output = {
    product: 'happier-server',
    channel,
    version,
    outDir,
    entrypoint,
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
