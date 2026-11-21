import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createFileChangeObserver } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { resolveHeadReflogPath } from '../../build/source_revision.mjs';
import { attributeBreakLane } from '../../perf/break-attribution.mjs';

const runGit = promisify(execFile);
const INPUTS = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'];
/** The boards lanes name their writes on, newest first. */
export const RELOAD_ATTRIBUTION_BOARDS = ['.project/plans/2026-10-26-implementation/BOARD.md',
  '.project/reviews/2026-10-02-lane12-replan/HANDOFF-OTHER-PROGRAMS.md'];

async function gitOut(repoDir, args, signal) {
  return (await runGit('git', ['-C', repoDir, ...args], { maxBuffer: 1 << 20, signal })).stdout.trim();
}

async function readInputDrift({ repoDir, inputs, boards, signal }) {
  const head = await gitOut(repoDir, ['rev-parse', '--verify', 'HEAD'], signal);
  const differs = await Promise.all(inputs.map(async input => {
    const file = join(repoDir, input);
    const [working, committed] = await Promise.all([
      gitOut(repoDir, ['hash-object', '--', input], signal).catch(async error => {
        if (await stat(file).then(() => true, failure => {
          if (failure.code !== 'ENOENT') throw failure;
          return false;
        })) throw error;
        return null;
      }),
      gitOut(repoDir, ['rev-parse', '--verify', '--quiet', `${head}:${input}`], signal).catch(error => {
        if (error.code !== 1) throw error;
        return null;
      }),
    ]);
    return working !== committed;
  }));
  const path = inputs[differs.indexOf(true)];
  if (!path) return null;
  const mtimeMs = await stat(join(repoDir, path)).then(info => info.mtimeMs, error => {
    if (error.code !== 'ENOENT') throw error;
    return Date.now();
  });
  let attributed = null;
  for (const board of boards) {
    attributed = await attributeBreakLane({ repoDir, board, files: [{ path, mtimeMs }], module: path });
    if (attributed) break;
  }
  const since = new Date(mtimeMs).toISOString();
  const author = attributed?.lane ?? null;
  return { status: 'wait', path, owner: author,
    code: path === 'pnpm-lock.yaml' ? 'working_lockfile_differs_from_head' : 'working_workspace_differs_from_head',
    message: `the shared checkout's ${path} differs from HEAD (edited ${since}). `
      + `${author ? `${author} named that write on the board` : 'No board post names that write'}.`,
    nextAction: author ? `${author} can commit ${path} with its manifests or revert it` : `Find the writer of ${path} and have it committed or reverted`,
  };
}

function inputStamp(path) {
  try {
    const { ino, mtimeNs, ctimeNs } = statSync(path, { bigint: true });
    return `${ino}:${mtimeNs}:${ctimeNs}`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

/** A committed revision can adopt the shared dependency snapshot once the
 * install inputs match HEAD. A declared overlay owns its own input bytes.
 * Reloads wait with their pending request. A one-shot QA probe reports drift. */
export async function preflightWorkingDependencyInputs({ repoDir, overlay = [],
  boards = RELOAD_ATTRIBUTION_BOARDS.map(path => join(repoDir, path)), onWait, signal }) {
  const inputs = INPUTS.filter(input => !overlay.includes(input));
  if (!inputs.length) return;
  const check = () => readInputDrift({ repoDir, inputs, boards, signal });
  if (!onWait) {
    const wait = await check();
    if (wait) throw Object.assign(new Error(`[reload] ${wait.message} ${wait.nextAction}. Incumbent retained.`),
      { ...wait, phase: 'preflight', retryable: true });
    return;
  }
  const headLog = await resolveHeadReflogPath(repoDir);
  const paths = [...inputs.map(input => join(repoDir, input)), headLog];
  const readSnapshot = () => paths.map(inputStamp).join('|');
  let reportedPath;
  for (;;) {
    signal?.throwIfAborted();
    const snapshot = readSnapshot();
    const wait = await check();
    signal?.throwIfAborted();
    if (snapshot !== readSnapshot()) continue;
    if (!wait) return;
    if (wait.path !== reportedPath) {
      reportedPath = wait.path;
      await onWait(wait);
    }
    const change = Promise.withResolvers();
    const onAbort = () => change.reject(signal.reason);
    const checkSnapshot = () => {
      try { if (snapshot !== readSnapshot()) change.resolve(); }
      catch (error) { change.reject(error); }
    };
    const observer = createFileChangeObserver(new Set(paths.map(path => dirname(path))), {
      persistent: true,
      isRelevant: (directory, filename) => !filename || paths.some(path => dirname(path) === directory && basename(path) === String(filename)),
      onError: change.reject,
    });
    try {
      observer.subscribe(checkSnapshot);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      checkSnapshot();
      await change.promise;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      observer.close();
    }
  }
}
