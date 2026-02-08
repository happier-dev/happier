import { runCapture } from '../proc/proc.mjs';

function isTruthyEnvValue(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return false;
  return raw !== '0' && raw !== 'false';
}

export async function openUrlInBrowser(url, { timeoutMs = 5_000 } = {}) {
  const u = String(url ?? '').trim();
  if (!u) return { ok: false, error: 'missing_url' };
  if (isTruthyEnvValue(process.env.HAPPIER_NO_BROWSER_OPEN) || isTruthyEnvValue(process.env.HAPPIER_STACK_NO_BROWSER)) {
    return { ok: false, error: 'browser_open_disabled' };
  }

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
