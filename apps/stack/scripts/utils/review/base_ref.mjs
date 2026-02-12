import { inferRemoteNameForOwner, parseGithubOwner } from '../git/worktrees.mjs';
import { gitCapture, gitOk, normalizeRemoteName, resolveRemoteDefaultBranch, ensureRemoteRefAvailable } from '../git/git.mjs';

async function currentBranchName({ cwd }) {
  const branch = (await gitCapture({ cwd, args: ['branch', '--show-current'] }).catch(() => '')).trim();
  return branch;
}

function branchOwnerPrefix(branch) {
  const b = String(branch ?? '').trim();
  if (!b || !b.includes('/')) return '';
  return b.split('/')[0] ?? '';
}

async function inferRemoteFromBranchOwner({ cwd }) {
  const branch = await currentBranchName({ cwd });
  const owner = branchOwnerPrefix(branch);
  if (!owner) return '';

  // Confirm this "owner" is plausible (matches at least one remote's GitHub owner).
  for (const remoteName of ['upstream', 'origin', 'fork']) {
    try {
      const url = (await gitCapture({ cwd, args: ['remote', 'get-url', remoteName] })).trim();
      const parsedOwner = parseGithubOwner(url);
      if (parsedOwner && parsedOwner === owner) {
        return remoteName;
      }
    } catch {
      // ignore
    }
  }

  // Fall back to the generic inference helper (it checks remotes in priority order).
  return await inferRemoteNameForOwner({ repoDir: cwd, owner });
}

export async function resolveBaseRef({
  cwd,
  baseRefOverride = '',
  baseRemoteOverride = '',
  baseBranchOverride = '',
  stackRemoteFallback = '',
} = {}) {
  const repoDir = String(cwd ?? '').trim();
  if (!repoDir) {
    throw new Error('[review] missing cwd for base resolution');
  }

  if (!(await gitOk({ cwd: repoDir, args: ['rev-parse', '--is-inside-work-tree'] }))) {
    throw new Error(`[review] not a git repository: ${repoDir}`);
  }

  const explicitRef = String(baseRefOverride ?? '').trim();
  if (explicitRef) {
    return { baseRef: explicitRef, remote: '', branch: '' };
  }

  const stackFallback = String(stackRemoteFallback ?? '').trim();
  const inferredRemote = await inferRemoteFromBranchOwner({ cwd: repoDir });
  const remoteCandidates = [];
  for (const name of [String(baseRemoteOverride ?? '').trim(), inferredRemote, stackFallback, 'upstream', 'origin', 'fork']) {
    if (!name || remoteCandidates.includes(name)) continue;
    remoteCandidates.push(name);
  }

  for (const candidate of remoteCandidates) {
    const remote = await normalizeRemoteName({ cwd: repoDir, remote: candidate });
    const branch = String(baseBranchOverride ?? '').trim() || (await resolveRemoteDefaultBranch({ cwd: repoDir, remote }));
    const ok = await ensureRemoteRefAvailable({ cwd: repoDir, remote, branch });
    if (ok) {
      return { baseRef: `${remote}/${branch}`, remote, branch };
    }
  }

  const first = remoteCandidates[0] || 'upstream';
  const remote = await normalizeRemoteName({ cwd: repoDir, remote: first });
  const branch = String(baseBranchOverride ?? '').trim() || (await resolveRemoteDefaultBranch({ cwd: repoDir, remote }));
  throw new Error(
    `[review] unable to resolve base ref refs/remotes/${remote}/${branch} in ${repoDir}\n` +
      `[review] hint: ensure remote "${remote}" exists and has a configured HEAD/default branch (or pass --base-ref).`
  );
}
