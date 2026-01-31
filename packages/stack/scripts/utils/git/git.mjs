import { runCapture } from '../proc/proc.mjs';

export async function gitCapture({ cwd, args }) {
  return String(await runCapture('git', args, { cwd }));
}

export async function gitOk({ cwd, args }) {
  try {
    await runCapture('git', args, { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function normalizeRemoteName({ cwd, remote }) {
  const want = String(remote ?? '').trim();
  if (!want) return want;

  if (await gitOk({ cwd, args: ['remote', 'get-url', want] })) return want;

  // Treat origin/fork as interchangeable if one exists.
  if (want === 'origin' && (await gitOk({ cwd, args: ['remote', 'get-url', 'fork'] }))) return 'fork';
  if (want === 'fork' && (await gitOk({ cwd, args: ['remote', 'get-url', 'origin'] }))) return 'origin';

  return want;
}

export async function resolveRemoteDefaultBranch({ cwd, remote }) {
  const r = String(remote ?? '').trim();
  if (!r) return 'main';

  // Prefer refs/remotes/<remote>/HEAD when available.
  try {
    const headRef = (await gitCapture({ cwd, args: ['symbolic-ref', '-q', '--short', `refs/remotes/${r}/HEAD`] })).trim();
    if (headRef.startsWith(`${r}/`)) {
      return headRef.slice(r.length + 1);
    }
  } catch {
    // ignore
  }

  // Fallback: parse `git remote show` output.
  try {
    const out = await gitCapture({ cwd, args: ['remote', 'show', r] });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*HEAD branch:\s*(.+)\s*$/);
      if (m?.[1]) return m[1].trim();
    }
  } catch {
    // ignore
  }

  return 'main';
}

export async function ensureRemoteRefAvailable({ cwd, remote, branch }) {
  const r = String(remote ?? '').trim();
  const b = String(branch ?? '').trim();
  if (!r || !b) return false;
  const ref = `refs/remotes/${r}/${b}`;
  if (await gitOk({ cwd, args: ['show-ref', '--verify', '--quiet', ref] })) return true;
  // Best-effort fetch of the default branch.
  await gitCapture({ cwd, args: ['fetch', '--quiet', r, b] }).catch(() => '');
  return await gitOk({ cwd, args: ['show-ref', '--verify', '--quiet', ref] });
}

