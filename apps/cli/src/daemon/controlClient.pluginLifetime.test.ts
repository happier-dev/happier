import { stubUndiciFetch } from '@/testkit/http/stubUndiciFetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubIssuedFetch } from '@/testkit/http/stubIssuedFetch';

import {
  controlDaemonPluginDevelopment, decideDaemonPluginChange, listDaemonPluginChanges,
  readDaemonPluginChangeStatus, requestDaemonPluginActionExecution, requestDaemonPluginChange,
} from './controlClient';
import type { DaemonControlRequestOptions } from './controlHttp';

const target = { pid: process.pid, httpPort: 1 };
const calls = [
  (options: DaemonControlRequestOptions) => requestDaemonPluginChange({ kind: 'installPath', locator: '/plugin', development: false }, options),
  (options: DaemonControlRequestOptions) => decideDaemonPluginChange({ pendingChangeId: 'change-1', decision: 'cancel' }, options),
  (options: DaemonControlRequestOptions) => readDaemonPluginChangeStatus({ pendingChangeId: 'change-1' }, options),
  (options: DaemonControlRequestOptions) => listDaemonPluginChanges(options),
  (options: DaemonControlRequestOptions) => controlDaemonPluginDevelopment({ kind: 'status' }, options),
  (options: DaemonControlRequestOptions) => requestDaemonPluginActionExecution({ actionId: 'acme.plugin/run', input: {}, surface: 'cli' }, options),
];

function installClock() {
  vi.useFakeTimers();
  // Clock and HTTP are system boundaries; AbortSignal uses a native clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
}

describe('plugin control operation lifetime', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each([undefined, null, 600_000])('accepts late settlement with timeout %s', async (timeoutMs) => {
    installClock();
    const issued = stubIssuedFetch((url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      const body = String(url).endsWith('/status') ? { kind: 'applying', pendingChangeId: 'change-1' }
        : String(url).endsWith('/list') ? { changes: [{ kind: 'applying', pendingChangeId: 'change-1' }] }
        : String(url).endsWith('/request') || String(url).endsWith('/decide') ? { kind: 'cancelled' }
        : { kind: 'status', status: { roots: [], plugins: [] }, matched: true, result: { ok: true } };
      const timer = setTimeout(() => resolve(Response.json(body)), 301_000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
    }), calls.length);
    const pending = [];
    for (const call of calls) {
      pending.push(call({ target, ...(timeoutMs === undefined ? {} : { timeoutMs }) }));
      // Vitest's manual-mock loader cannot resolve concurrent dynamic imports.
      // Finish module issuance while leaving every HTTP response pending.
      await vi.dynamicImportSettled();
    }
    await issued;
    await vi.advanceTimersByTimeAsync(301_000);
    const results = await Promise.all(pending);
    expect(results[0]).toMatchObject({ kind: 'cancelled' });
    expect(results[1]).toMatchObject({ kind: 'cancelled' });
    expect(results[4]).toMatchObject({ kind: 'status' });
    expect(results[5]).toMatchObject({ matched: true, result: { ok: true } });
    expect(results[2]).toEqual({ kind: 'applying', pendingChangeId: 'change-1' });
    expect(results[3]).toEqual({ kind: 'available', changes: [{ kind: 'applying', pendingChangeId: 'change-1' }] });
  });

  it('withdraws an unissued operation and preserves uncertainty after issuing an effect', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    stubUndiciFetch(fetch);
    const action = (options: DaemonControlRequestOptions) => requestDaemonPluginActionExecution({ actionId: 'acme.plugin/run', input: {}, surface: 'cli' }, options);
    await expect(action({ target, signal: controller.signal })).resolves.toMatchObject({ result: { errorCode: 'cancelled' } });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = action({ target, signal: active.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    active.abort();
    await expect(pending).resolves.toMatchObject({ result: { errorCode: 'outcome_unknown' } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps real daemon refusals', async () => {
    stubUndiciFetch(async () => Response.json({ errorCode: 'plugin_not_found', error: 'missing' }, { status: 404 }));
    await expect(requestDaemonPluginChange({ kind: 'installPath', locator: '/plugin', development: false }, { target }))
      .resolves.toEqual({ kind: 'unavailable', code: 'plugin_not_found' });
  });

  it.each([
    { name: 'change request', call: calls[0]!, expected: { kind: 'unavailable', code: 'outcome_unknown' } },
    { name: 'change decision', call: calls[1]!, expected: { kind: 'unavailable', code: 'outcome_unknown' } },
    { name: 'development change', call: (options: DaemonControlRequestOptions) => controlDaemonPluginDevelopment({ kind: 'reload', rootPath: '/plugin' }, options), expected: { kind: 'failed', code: 'outcome_unknown' } },
  ])('keeps $name uncertain after issuance and cancellation', async ({ call, expected }) => {
    const fetch = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    stubUndiciFetch(fetch);
    const controller = new AbortController();
    const pending = call({ target, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).resolves.toMatchObject(expected);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps an explicit caller deadline and cancels only that request', async () => {
    installClock();
    const issued = stubIssuedFetch((_url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ changes: [{ kind: 'applying', pendingChangeId: 'change-1' }] })), 2000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
    }), 2);
    const deadline = listDaemonPluginChanges({ target, timeoutMs: 1000 });
    const retained = listDaemonPluginChanges({ target });
    await issued;
    await vi.advanceTimersByTimeAsync(2000);
    await expect(deadline).resolves.toEqual({ kind: 'unavailable', code: 'timeout' });
    await expect(retained).resolves.toEqual({
      kind: 'available',
      changes: [{ kind: 'applying', pendingChangeId: 'change-1' }],
    });
  });
});
