import { runCapture } from './proc.mjs';

export async function resolveCommandPath(cmd, { cwd, env, timeoutMs } = {}) {
  const c = String(cmd ?? '').trim();
  if (!c) return '';

  try {
    if (process.platform === 'win32') {
      const out = (await runCapture('where', [c], { cwd, env, timeoutMs })).trim();
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
      return first;
    }
    return (
      await runCapture('sh', ['-lc', `command -v "${c}" 2>/dev/null || true`], { cwd, env, timeoutMs })
    ).trim();
  } catch {
    return '';
  }
}

export async function runCaptureIfCommandExists(cmd, args, { cwd, env, timeoutMs } = {}) {
  const resolved = await resolveCommandPath(cmd, { cwd, env, timeoutMs });
  if (!resolved) return '';
  try {
    return await runCapture(resolved, args, { cwd, env, timeoutMs });
  } catch {
    return '';
  }
}

export async function commandExists(cmd, { cwd, env, timeoutMs } = {}) {
  return Boolean(await resolveCommandPath(cmd, { cwd, env, timeoutMs }));
}
