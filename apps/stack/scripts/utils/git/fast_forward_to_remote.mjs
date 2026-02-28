import { runCapture } from '../proc/proc.mjs';

function trim(s) {
  return String(s ?? '').trim();
}

function parseCounts(out) {
  const s = trim(out);
  if (!s) return { behind: null, ahead: null };
  const [left, right] = s.split(/\s+/g).map((n) => Number(n));
  return {
    behind: Number.isFinite(left) ? left : null,
    ahead: Number.isFinite(right) ? right : null,
  };
}

/**
 * Best-effort fast-forward a local branch to a remote ref:
 * - checks working tree is clean
 * - fetches remote branch
 * - fast-forwards via `git merge --ff-only`
 *
 * Never force-resets or rewrites history.
 */
export async function fastForwardBranchToRemote({ dir, remote = 'origin', branch }) {
  const repoDir = trim(dir);
  const r = trim(remote) || 'origin';
  const b = trim(branch);
  if (!repoDir) {
    return { ok: false, updated: false, reason: 'missing-dir', error: '[git] missing dir' };
  }
  if (!b) {
    return { ok: false, updated: false, reason: 'missing-branch', error: '[git] missing branch' };
  }

  // Ensure we're on the requested branch (best-effort).
  let headRef = '';
  try {
    headRef = trim(await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir }));
  } catch (e) {
    return {
      ok: false,
      updated: false,
      reason: 'not-a-git-repo',
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (headRef && headRef !== b) {
    try {
      await runCapture('git', ['checkout', '-q', b], { cwd: repoDir });
    } catch (e) {
      return {
        ok: false,
        updated: false,
        reason: 'checkout-failed',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Refuse to fast-forward a dirty working tree.
  const dirty = trim(await runCapture('git', ['status', '--porcelain'], { cwd: repoDir }).catch(() => ''));
  if (dirty) {
    return { ok: false, updated: false, reason: 'dirty', error: '[git] working tree is not clean' };
  }

  const remoteRef = `${r}/${b}`;
  let oldHead = '';
  try {
    oldHead = trim(await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repoDir }));
  } catch {
    oldHead = '';
  }

  try {
    await runCapture('git', ['fetch', '--quiet', r, b], { cwd: repoDir });
  } catch (e) {
    return {
      ok: false,
      updated: false,
      reason: 'fetch-failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let remoteHead = '';
  try {
    remoteHead = trim(await runCapture('git', ['rev-parse', remoteRef], { cwd: repoDir }));
  } catch (e) {
    return {
      ok: false,
      updated: false,
      reason: 'remote-ref-missing',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (oldHead && remoteHead && oldHead === remoteHead) {
    return { ok: true, updated: false, reason: 'up-to-date', oldHead, newHead: oldHead };
  }

  const counts = parseCounts(
    await runCapture('git', ['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`], { cwd: repoDir }).catch(() => '')
  );
  const behind = counts.behind ?? 0;
  const ahead = counts.ahead ?? 0;

  if (behind === 0 && ahead > 0) {
    return { ok: false, updated: false, reason: 'ahead', oldHead, remoteHead, behind, ahead };
  }
  if (behind > 0 && ahead > 0) {
    return { ok: false, updated: false, reason: 'diverged', oldHead, remoteHead, behind, ahead };
  }
  if (behind === 0 && ahead === 0) {
    // Some repos can hit this state when HEAD is detached but points at the same commit.
    return { ok: true, updated: false, reason: 'up-to-date', oldHead, newHead: oldHead };
  }

  try {
    await runCapture('git', ['merge', '--ff-only', remoteRef], { cwd: repoDir });
  } catch (e) {
    return {
      ok: false,
      updated: false,
      reason: 'ff-failed',
      error: e instanceof Error ? e.message : String(e),
      oldHead,
      remoteHead,
      behind,
      ahead,
    };
  }

  const newHead = trim(await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).catch(() => remoteHead));
  return { ok: true, updated: true, reason: 'fast-forwarded', oldHead, newHead, remoteHead, behind, ahead };
}
