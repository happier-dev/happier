import { setTimeout as delay } from 'node:timers/promises';
import { STACK_LISTENER_OBSERVATION_TIMEOUT_MS } from './listener_ownership.mjs';

// Expo, gateways and infrastructure endpoints need an HTTP listener, not the
// Happier-specific /health contract. Their startup owner controls cancellation.
export async function waitForHttpOk(url, { timeoutMs = 15_000, intervalMs = 250, signal, childProcess } = {}) {
  const exited = new AbortController();
  const onExit = () => exited.abort(Object.assign(new Error('HTTP listener process exited before readiness'), { code: 'EPROCESSEXITED' }));
  const lifetime = signal ? AbortSignal.any([signal, exited.signal]) : exited.signal;
  childProcess?.once('exit', onExit);
  childProcess?.once('error', onExit);
  if (childProcess && (childProcess.exitCode != null || childProcess.signalCode != null)) onExit();
  const deadline = Date.now() + timeoutMs;
  try {
    lifetime.throwIfAborted();
    while (Date.now() < deadline) {
      lifetime.throwIfAborted();
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), Math.min(STACK_LISTENER_OBSERVATION_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
      try {
        const res = await fetch(url, { method: 'GET', signal: AbortSignal.any([lifetime, ctl.signal]) });
        await res.body?.cancel();
        lifetime.throwIfAborted();
        if (res.status >= 100 && res.status < 600) return;
      } catch {
        lifetime.throwIfAborted();
      } finally {
        clearTimeout(t);
      }
      await delay(intervalMs, undefined, { signal: lifetime });
    }
    throw new Error(`Timed out waiting for HTTP response from ${url} after ${timeoutMs}ms`);
  } finally {
    childProcess?.off('exit', onExit);
    childProcess?.off('error', onExit);
  }
}
