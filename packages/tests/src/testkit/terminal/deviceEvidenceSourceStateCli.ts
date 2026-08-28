import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { createTerminalNativeSourceState } from './deviceEvidenceRunBundle';

const INCLUDED_ROOTS = ['app.json', 'package.json', 'yarn.lock', 'apps/ui', 'packages', 'scripts'] as const;
const EXCLUDED_SEGMENTS = new Set(['.cxx', '.expo', '.git', '.gradle', '.project', 'Pods', 'Vendor', 'DerivedData', 'build', 'node_modules']);
const EXCLUDED_FILES = new Set(['happier-terminal-native-build-identity.json']);

async function walk(path: string, files: string[]): Promise<void> {
  const info = await stat(path);
  if (info.isFile()) {
    files.push(path);
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || EXCLUDED_SEGMENTS.has(entry.name) || EXCLUDED_FILES.has(entry.name)) continue;
    await walk(resolve(path, entry.name), files);
  }
}

export async function runTerminalNativeSourceStateCli(args: readonly string[]): Promise<number> {
  const [sourceRootArg, outputPathArg, commit, dirtyArg] = args;
  if (!sourceRootArg || !outputPathArg || !/^[a-f0-9]{40}$/.test(commit ?? '')
    || (dirtyArg !== 'true' && dirtyArg !== 'false')) {
    console.error('Usage: capture-source-state.mjs <source-root> <output-path> <commit> <true|false>');
    return 2;
  }
  const sourceRoot = resolve(sourceRootArg);
  const files: string[] = [];
  for (const includedRoot of INCLUDED_ROOTS) await walk(resolve(sourceRoot, includedRoot), files);
  const inventory = [];
  for (const path of files.sort()) {
    inventory.push({
      path: relative(sourceRoot, path).split(sep).join('/'),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    });
  }
  const report = createTerminalNativeSourceState({
    sourceCommit: commit,
    sourceDirty: dirtyArg === 'true',
    generatedAt: new Date().toISOString(),
    inventory,
  });
  await mkdir(dirname(resolve(outputPathArg)), { recursive: true });
  await writeFile(resolve(outputPathArg), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputPath: resolve(outputPathArg), files: inventory.length, inventorySha256: report.inventorySha256 }));
  return 0;
}

if (process.argv[1]?.endsWith('deviceEvidenceSourceStateCli.ts')) {
  process.exitCode = await runTerminalNativeSourceStateCli(process.argv.slice(2));
}
