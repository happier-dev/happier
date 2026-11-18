import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { attributeBreakLane } from '../../perf/break-attribution.mjs';

const runGit = promisify(execFile);
const LOCKFILE = 'pnpm-lock.yaml';
/** The boards lanes name their writes on, newest first (the implementation board, then the handoff board). */
export const RELOAD_ATTRIBUTION_BOARDS = ['.project/plans/2026-10-26-implementation/BOARD.md',
  '.project/reviews/2026-10-02-lane12-replan/HANDOFF-OTHER-PROGRAMS.md'];

async function gitOut(repoDir, args) {
  return (await runGit('git', ['-C', repoDir, ...args], { maxBuffer: 1 << 20 })).stdout.trim();
}

/**
 * RU2 B.3 (Coordination 2026-11-18 08:52Z). A revision's dependency installation is a hardlink snapshot
 * of the checkout's published installation only when their dependency identities match. An uncommitted
 * lockfile edit in the shared checkout breaks that for every committed revision, so each reload took the
 * own-lockfile install path instead (three times on 11-17). Refuse before any preparation and name the
 * lane whose board post names the write (the load-break attribution owner), so it commits or reverts.
 * A Stack that declares the lockfile in its overlay asked for those bytes and is not refused.
 */
export async function refuseWorkingLockfileDrift({ repoDir, overlay = [], boards = RELOAD_ATTRIBUTION_BOARDS.map(path => join(repoDir, path)) }) {
  if (overlay.includes(LOCKFILE)) return;
  const [working, committed] = await Promise.all([gitOut(repoDir, ['hash-object', '--', LOCKFILE]).catch(() => null),
    gitOut(repoDir, ['rev-parse', `HEAD:${LOCKFILE}`]).catch(() => null)]);
  if (working === committed) return;
  const mtimeMs = await stat(join(repoDir, LOCKFILE)).then(info => info.mtimeMs, () => Date.now());
  let attributed = null;
  for (const board of boards) {
    attributed = await attributeBreakLane({ repoDir, board, files: [{ path: LOCKFILE, mtimeMs }], module: LOCKFILE });
    if (attributed) break;
  }
  const since = new Date(mtimeMs).toISOString();
  throw Object.assign(new Error(`[reload] the shared checkout's ${LOCKFILE} differs from HEAD (edited ${since}); `
    + `${attributed ? `${attributed.lane} named that write on the board` : 'no board post names that write'}. `
    + `A committed revision cannot adopt the dependency snapshot until it is committed with its manifests or reverted by its writer; incumbent retained`), {
    code: 'working_lockfile_differs_from_head', phase: 'preflight', retryable: true, owner: attributed?.lane ?? null,
    nextAction: attributed ? `${attributed.lane}: commit ${LOCKFILE} with its manifests, or revert it` : `Find the writer of the uncommitted ${LOCKFILE} (edited ${since}) and have it committed or reverted`,
  });
}
