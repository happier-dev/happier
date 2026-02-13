#!/usr/bin/env node

import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

import {
  CLI_STACK_TARGETS,
  commandExists,
  compileBunBinary,
  ensureFileExists,
  execOrThrow,
  normalizeChannel,
  packageTargetBinary,
  parseArgs,
  parseCsv,
  readVersionFromPackageJson,
  resolveYarnCommand,
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
    || readVersionFromPackageJson(join(repoRoot, 'apps', 'cli', 'package.json'));
  const outDir = join(repoRoot, 'dist', 'release-assets', 'cli');
  const tempDir = join(repoRoot, 'dist', 'release-assets', '.tmp-cli-binaries');
  const entrypoint = join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs');
  const externals = parseCsv(kv.get('--externals') ?? process.env.HAPPIER_CLI_BUN_EXTERNALS ?? '');
  const targets = resolveTargets({
    availableTargets: CLI_STACK_TARGETS,
    requested: kv.get('--targets'),
  });

  const yarn = resolveYarnCommand();
  execOrThrow(yarn.cmd, [...yarn.args, '--cwd', 'apps/cli', 'build'], { cwd: repoRoot });
  await ensureFileExists(entrypoint);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const artifacts = [];
  for (const target of targets) {
    const compiledPath = join(tempDir, `happier-${target.os}-${target.arch}${target.exeExt}`);
    await compileBunBinary({
      entrypoint,
      bunTarget: target.bunTarget,
      outfile: compiledPath,
      cwd: repoRoot,
      externals,
    });
    const artifact = await packageTargetBinary({
      product: 'happier',
      version,
      target,
      executableName: 'happier',
      buildTempDir: tempDir,
      outDir,
      compiledPath,
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
