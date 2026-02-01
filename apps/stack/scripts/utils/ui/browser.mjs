import { runCapture } from '../proc/proc.mjs';

export async function openUrlInBrowser(url, { timeoutMs = 5_000 } = {}) {
  const u = String(url ?? '').trim();
  if (!u) return { ok: false, error: 'missing_url' };

  try {
    if (process.platform === 'darwin') {
      await runCapture('open', [u], { timeoutMs });
      return { ok: true, method: 'open' };
    }
    if (process.platform === 'win32') {
      // `start` is a cmd built-in; the empty title ("") is required so URLs with :// don't get treated as a title.
      await runCapture('cmd', ['/c', 'start', '""', u], { timeoutMs });
      return { ok: true, method: 'cmd-start' };
    }
    await runCapture('xdg-open', [u], { timeoutMs });
    return { ok: true, method: 'xdg-open' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
