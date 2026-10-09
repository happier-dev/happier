import { describe, expect, it, vi } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { invokeScopedModalRole } from './scopedSdk.js';
import { MODAL_ACCOUNT_PURPOSE, MODAL_ENV_KEYS } from './connectedAccount.js';

const workerBoundary = vi.hoisted(() => ({ env: {} as Record<string, string>, terminated: false, entry: '',
  holdCompletion: false, latest: undefined as undefined | { emit(event: string, value: unknown): boolean } }));
// Thread creation is the OS boundary; the real credential-scoping owner stays live.
vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return { Worker: class extends Emitter {
    constructor(entry: string, options: { env: Record<string, string> }) {
      super(); workerBoundary.entry = entry; workerBoundary.env = options.env; workerBoundary.latest = this;
      if (!workerBoundary.holdCompletion) queueMicrotask(() => this.emit('message', { ok: true, value: { available: true } }));
    }
    postMessage() {}
    async terminate() { workerBoundary.terminated = true; return 0; }
  } };
});

const account = { service: { pluginId: 'happier.machine.modal', localId: 'modal-account' }, accountId: 'selected-account' };
function context(env: Record<string, string>, signal = new AbortController().signal) {
  const getBinding = vi.fn(async () => ({ purpose: MODAL_ACCOUNT_PURPOSE, service: account.service, account,
    target: { kind: 'account', displayName: 'Selected Modal' } }));
  const materialize = vi.fn(async () => ({ kind: 'environment', env }));
  // Invocation and credential services are host system-boundary fixtures.
  const value = { invokedAtMs: 123, signal,
    services: { connectedAccounts: { getBinding, materialize } } } as unknown as PluginInvocationContext;
  return { value, getBinding, materialize };
}

describe('Modal scoped SDK construction', () => {
  const credentials = { MODAL_TOKEN_ID: 'dummy-id', MODAL_TOKEN_SECRET: 'dummy-secret', MODAL_SERVER_URL: 'http://127.0.0.1:1' };
  it('pins the selected account and gives the vendor a fresh explicit profile environment before import', async () => {
    const selected = { MODAL_TOKEN_ID: 'dummy-token-id', MODAL_TOKEN_SECRET: 'dummy-token-secret',
      MODAL_SERVER_URL: 'http://127.0.0.1:1', MODAL_ENVIRONMENT: 'selected-environment',
      MODAL_PROFILE: 'ambient-profile-must-not-propagate', NODE_OPTIONS: 'ambient-options-must-not-propagate' };
    const fixture = context(selected);
    expect(await invokeScopedModalRole('check', {}, fixture.value)).toEqual({ available: true });
    expect(fixture.materialize).toHaveBeenCalledWith(MODAL_ACCOUNT_PURPOSE,
      { kind: 'environment', keys: MODAL_ENV_KEYS }, { signal: fixture.value.signal, expectedAccount: account });
    expect(workerBoundary.env).toMatchObject({ MODAL_TOKEN_ID: selected.MODAL_TOKEN_ID, MODAL_TOKEN_SECRET: selected.MODAL_TOKEN_SECRET,
      MODAL_SERVER_URL: selected.MODAL_SERVER_URL, MODAL_ENVIRONMENT: selected.MODAL_ENVIRONMENT });
    expect(workerBoundary.env.MODAL_CONFIG_PATH).toMatch(/happier-modal-config-.*absent\.toml$/);
    expect(workerBoundary.env.MODAL_PROFILE).toBeUndefined();
    expect(workerBoundary.env.NODE_OPTIONS).toBeUndefined();
    expect(workerBoundary.entry).toMatch(/sdkWorker\.(?:ts|js)$/);
    expect(workerBoundary.terminated).toBe(true);
  });

  it('refuses incomplete selected credentials before vendor thread construction', async () => {
    workerBoundary.terminated = false;
    await expect(invokeScopedModalRole('acquire', {}, context({ MODAL_TOKEN_ID: 'dummy-token' }).value))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(workerBoundary.terminated).toBe(false);
  });

  it('settles aborted private exec without claiming guest termination and disposes the native worker', async () => {
    workerBoundary.holdCompletion = true;
    workerBoundary.terminated = false;
    const cancellation = new AbortController();
    let outcome: unknown;
    const pending = invokeScopedModalRole('exec', {}, context(credentials, cancellation.signal).value)
      .then(value => { outcome = value; }, error => { outcome = error; });
    await new Promise<void>(resolve => setImmediate(resolve));
    cancellation.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(outcome).toMatchObject({ code: 'modal_operation_cancelled' });
      expect(workerBoundary.terminated).toBe(true);
    } finally {
      // Complete a pre-fix pending boundary call so RED does not leak work.
      workerBoundary.latest?.emit('message', { ok: true, value: { native: 'late-result' } });
      await pending;
      workerBoundary.holdCompletion = false;
    }
  });

  it('preserves late allocation custody rather than killing the acquire worker on abort', async () => {
    workerBoundary.holdCompletion = true;
    workerBoundary.terminated = false;
    const cancellation = new AbortController();
    let settled = false;
    const custody = { kind: 'bound', resource: { value: { appId: 'ap-dummy', sandboxId: 'sb-dummy' } } };
    const pending = invokeScopedModalRole('acquire', {}, context(credentials, cancellation.signal).value)
      .then(value => { settled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    cancellation.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(settled).toBe(false);
      expect(workerBoundary.terminated).toBe(false);
    } finally {
      workerBoundary.latest?.emit('message', { ok: true, value: custody });
      expect(await pending).toEqual(custody);
      expect(workerBoundary.terminated).toBe(true);
      workerBoundary.holdCompletion = false;
    }
  });
});
