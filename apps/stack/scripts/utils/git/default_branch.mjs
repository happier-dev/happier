import { runCapture } from '../proc/proc.mjs';

function trim(s) {
  return String(s ?? '').trim();
}

export async function resolveDefaultRemoteBranch({ dir, remote = 'origin' } = {}) {
  const repoDir = trim(dir);
  const r = trim(remote) || 'origin';
  if (!repoDir) return '';

  let ref = '';
  try {
    ref = trim(await runCapture('git', ['symbolic-ref', '-q', `refs/remotes/${r}/HEAD`], { cwd: repoDir }));
  } catch {
    return '';
  }
  if (!ref) return '';
  const prefix = `refs/remotes/${r}/`;
  if (!ref.startsWith(prefix)) return '';
  return ref.slice(prefix.length);
}
