#!/usr/bin/env node

// @ts-check

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseArgs, resolveRepoRoot } from './lib/binary-release.mjs';

export const INSTALLER_PUBLISH_SPECS = [
  { source: 'install.sh', targets: ['install.sh', 'install'] },
  { source: 'install.sh', targets: ['install-preview.sh', 'install-preview'], transform: 'preview-default-channel' },
  { source: 'install-server', targets: ['install-server'] },
  { source: 'install-server.sh', targets: ['install-server.sh'] },
  { source: 'self-host.sh', targets: ['self-host.sh', 'self-host'] },
  { source: 'self-host.sh', targets: ['self-host-preview.sh', 'self-host-preview'], transform: 'preview-default-channel' },
  { source: 'install.ps1', targets: ['install.ps1'] },
  { source: 'install.ps1', targets: ['install-preview.ps1'], transform: 'preview-default-channel' },
  { source: 'self-host.ps1', targets: ['self-host.ps1'] },
  { source: 'self-host.ps1', targets: ['self-host-preview.ps1'], transform: 'preview-default-channel' },
  { source: 'happier-release.pub', targets: ['happier-release.pub'] },
];

export const INSTALLER_FILENAMES = INSTALLER_PUBLISH_SPECS.flatMap((spec) => spec.targets);

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

function applyTransform(contents, transform) {
  if (!transform) return contents;
  const raw = contents.toString('utf8');
  if (transform === 'preview-default-channel') {
    const shellUpdated = raw.replaceAll('HAPPIER_CHANNEL:-stable', 'HAPPIER_CHANNEL:-preview');
    const lines = shellUpdated.split('\n');
    const ps1Updated = lines
      .map((line) => {
        if (!line.includes('$Channel')) return line;
        if (!line.includes('"stable"')) return line;
        return line.replace('"stable"', '"preview"');
      })
      .join('\n');
    return Buffer.from(ps1Updated, 'utf8');
  }
  throw new Error(`[release] unknown installer transform: ${transform}`);
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function syncInstallers({
  sourceDir,
  targetDir,
  checkOnly = false,
}) {
  const changed = [];
  const checked = [];
  await mkdir(targetDir, { recursive: true });

  const desiredTargetMode = 0o644;
  for (const spec of INSTALLER_PUBLISH_SPECS) {
    const sourcePath = join(sourceDir, spec.source);
    const sourceContents = await readFileOrNull(sourcePath);
    if (!sourceContents) {
      throw new Error(`[release] missing installer source file: ${sourcePath}`);
    }
    const publishedContents = applyTransform(sourceContents, spec.transform);

    for (const name of spec.targets) {
      const targetPath = join(targetDir, name);
      const targetContents = await readFileOrNull(targetPath);
      checked.push(name);

      const contentInSync = buffersEqual(publishedContents, targetContents);
      if (!contentInSync) {
        changed.push(name);
        if (!checkOnly) {
          await writeFile(targetPath, publishedContents);
        }
        continue;
      }

      // Even when the file contents match, normalize the published copy's mode so
      // "executable bit" drift doesn't create noisy diffs in the repo.
      if (!checkOnly && (await fileExists(targetPath))) {
        await chmod(targetPath, desiredTargetMode);
      }
    }
  }

  // Note: chmod doesn't report whether it changed anything; "changed" is content drift only.
  // We intentionally keep this simple: mode normalization is best-effort hygiene.

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
