#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseArgs, resolveRepoRoot } from './lib/binary_release.mjs';

export const INSTALLER_FILENAMES = [
  'install.sh',
  'install-server',
  'install-server.sh',
  'self-host.sh',
  'install.ps1',
  'happier-release.pub',
];

async function readFileOrNull(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function buffersEqual(left, right) {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.equals(right);
}

export async function syncInstallers({
  sourceDir,
  targetDir,
  checkOnly = false,
}) {
  const changed = [];
  const checked = [];
  await mkdir(targetDir, { recursive: true });

  for (const name of INSTALLER_FILENAMES) {
    const sourcePath = join(sourceDir, name);
    const targetPath = join(targetDir, name);
    const sourceContents = await readFileOrNull(sourcePath);
    if (!sourceContents) {
      throw new Error(`[release] missing installer source file: ${sourcePath}`);
    }
    const targetContents = await readFileOrNull(targetPath);
    checked.push(name);

    if (buffersEqual(sourceContents, targetContents)) {
      continue;
    }
    changed.push(name);
    if (!checkOnly) {
      await writeFile(targetPath, sourceContents);
    }
  }

  if (checkOnly && changed.length > 0) {
    throw new Error(`[release] installer artifacts are out of sync: ${changed.join(', ')}`);
  }

  return {
    ok: true,
    checkOnly,
    checked,
    changed,
    sourceDir,
    targetDir,
  };
}

async function main() {
  const repoRoot = resolveRepoRoot();
  const { kv, flags } = parseArgs(process.argv.slice(2));
  const checkOnly = flags.has('--check');
  const sourceDir = resolve(String(kv.get('--source-dir') ?? join(repoRoot, 'scripts', 'release', 'installers')));
  const targetDir = resolve(String(kv.get('--target-dir') ?? join(repoRoot, 'apps', 'website', 'public')));

  const result = await syncInstallers({
    sourceDir,
    targetDir,
    checkOnly,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
