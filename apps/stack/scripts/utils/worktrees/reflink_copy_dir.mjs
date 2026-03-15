import { runCapture } from '../proc/proc.mjs';

function trim(s) {
  return String(s ?? '').trim();
}

export async function reflinkCopyDir({ srcDir, destDir }) {
  const src = trim(srcDir);
  const dest = trim(destDir);
  if (!src || !dest) return { ok: false, reason: 'missing-path' };

  // Attempt a copy-on-write clone of a directory tree.
  // If the underlying filesystem doesn't support it, fail closed so callers can fall back.
  const cmd = 'cp';
  const args = (() => {
    if (process.platform === 'darwin') {
      // -c: clonefile(2) (APFS CoW), -R: recursive
      return ['-cR', src, dest];
    }
    if (process.platform === 'linux') {
      // --reflink=always fails if CoW isn't supported; -a preserves perms/symlinks.
      return ['-a', '--reflink=always', src, dest];
    }
    return null;
  })();

  if (!args) return { ok: false, reason: 'unsupported-platform' };

  try {
    await runCapture(cmd, args, { cwd: undefined });
    return { ok: true, reason: 'reflink' };
  } catch (e) {
    return { ok: false, reason: 'copy-failed', error: e instanceof Error ? e.message : String(e) };
  }
}
