import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const runGit = promisify(execFile);
export const RELOAD_DEPENDENCY_INPUTS = Object.freeze(['pnpm-lock.yaml', 'pnpm-workspace.yaml']);

export async function gitOut(repoDir, args, signal) {
  return (await runGit('git', ['-C', repoDir, ...args], { maxBuffer: 1 << 20, signal })).stdout.trim();
}

export async function readDependencyInputBlob(repoDir, input, revision, signal) {
  if (revision) {
    return gitOut(repoDir, ['rev-parse', '--verify', '--quiet', `${revision}:${input}`], signal).catch(error => {
      if (error.code !== 1) throw error;
      return null;
    });
  }
  return gitOut(repoDir, ['hash-object', '--', input], signal).catch(async error => {
    if (await stat(join(repoDir, input)).then(() => true, failure => {
      if (failure.code !== 'ENOENT') throw failure;
      return false;
    })) throw error;
    return null;
  });
}

export async function clearsWorkingDependencyInputDrift({ repoDir, head, tree }) {
  const inputs = await Promise.all(RELOAD_DEPENDENCY_INPUTS.map(input => Promise.all([
    readDependencyInputBlob(repoDir, input), readDependencyInputBlob(repoDir, input, head),
    readDependencyInputBlob(repoDir, input, tree),
  ])));
  return inputs.every(([working, , proposed]) => working === proposed)
    && inputs.some(([working, committed]) => working !== null && working !== committed);
}
