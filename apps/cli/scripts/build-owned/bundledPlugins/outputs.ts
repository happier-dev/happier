import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { publishStagedDirectoryMountedSync } from '../../../../../packages/cli-common/workspaceRuntimeDependencies.mjs';

export type GeneratorMode = 'write' | 'check';

export type CoherentProjectionOutput = Readonly<{
  outPath: string;
  out: string;
}>;

export function writeFileAtomic(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return true;
}

/** Publishes a changed projection family as one mounted-tree transaction. */
export function publishCoherentProjectionOutputs(
  rootDir: string,
  outputs: readonly CoherentProjectionOutput[],
): void {
  const resolvedRootDir = resolve(rootDir);
  const changedOutputs = outputs.filter(({ outPath, out }) => (
    !existsSync(outPath) || readFileSync(outPath, 'utf8') !== out
  ));
  if (changedOutputs.length === 0) return;

  const stagingRoot = mkdtempSync(join(resolvedRootDir, '.bundled-plugin-projection-stage-'));
  const rollbackRoot = `${stagingRoot}.rollback`;
  try {
    for (const { outPath, out } of changedOutputs) {
      const relativeOutPath = relative(resolvedRootDir, resolve(outPath));
      if (!relativeOutPath || relativeOutPath === '..' || relativeOutPath.startsWith(`..${sep}`)) {
        throw new Error(`Bundled plugin projection output escapes its root: ${outPath}`);
      }
      const stagedOutPath = resolve(stagingRoot, relativeOutPath);
      mkdirSync(dirname(stagedOutPath), { recursive: true });
      writeFileSync(stagedOutPath, out, 'utf8');
    }
    publishStagedDirectoryMountedSync({
      stagedDir: stagingRoot,
      liveDir: resolvedRootDir,
      rollbackDir: rollbackRoot,
      pruneStale: false,
    });
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(rollbackRoot, { recursive: true, force: true });
  }
}

export function assertGeneratedOutputMatches(filePath: string, expected: string): void {
  if (!existsSync(filePath)) throw new Error(`missing generated output: ${filePath}`);
  const actual = readFileSync(filePath, 'utf8');
  if (actual !== expected) {
    let offset = 0;
    const sharedLength = Math.min(actual.length, expected.length);
    while (offset < sharedLength && actual[offset] === expected[offset]) offset += 1;
    const start = Math.max(0, offset - 80);
    const end = offset + 160;
    throw new Error(
      `generated output differs: ${filePath} at byte ${offset} `
      + `(actual=${JSON.stringify(actual.slice(start, end))}, `
      + `expected=${JSON.stringify(expected.slice(start, end))})`,
    );
  }
}

export function removeRetiredGeneratedOutput(filePath: string, mode: GeneratorMode): void {
  if (!existsSync(filePath)) return;
  if (mode === 'check') throw new Error(`retired generated output still exists: ${filePath}`);
  unlinkSync(filePath);
}
