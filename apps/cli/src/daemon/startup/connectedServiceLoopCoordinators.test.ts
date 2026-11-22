import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '@/api/api';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { startConnectedServiceRefreshLoop } from '../connectedServices/refresh/startConnectedServiceRefreshLoop';
import { startConnectedServiceQuotasLoop } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createConnectedServiceQuotaLoopCoordinator, createConnectedServiceRefreshLoopCoordinator } from './connectedServiceLoopCoordinators';

afterEach(() => vi.restoreAllMocks());

it.each(['refresh', 'quota', 'quota-currentness'] as const)('cancels the startup %s adapter while its Home read is pending', async mode => {
  const credentials = { token: 'startup-loop-cancellation-fixture', encryption: null };
  const api = await ApiClient.create(credentials);
  let entered!: () => void;
  const requestEntered = new Promise<void>(resolve => { entered = resolve; });
  const releaseReads = new Set<() => void>();
  let requestSignal: AbortSignal | undefined;
  let reads = 0;
  let activeReads = 0;
  // Home HTTP is substituted; the startup adapter, interval loop, coordinator
  // and HTTP client below it all execute their real implementations.
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness' || path === '/v1/account/encryption') {
      const block = mode === 'quota-currentness' ? path.endsWith('/currentness') : !path.endsWith('/currentness');
      if (block) {
        reads++; activeReads++;
        requestSignal = config?.signal instanceof AbortSignal ? config.signal : undefined;
        entered();
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(requestSignal?.reason);
            releaseReads.add(() => { requestSignal?.removeEventListener('abort', abort); resolve(); });
            requestSignal?.addEventListener('abort', abort, { once: true });
            if (requestSignal?.aborted) abort();
          });
        } finally { activeReads--; }
      }
      return { status: 200, data: path.endsWith('/currentness')
        ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }
        : { mode: 'plain', updatedAt: 0 } };
    }
    return { status: 404, data: null };
  });
  const refresh = new ConnectedServiceRefreshCoordinator({ api, credentials, machineIdProvider: () => 'machine',
    activeServerDir: '/fixture/active', baseDir: '/fixture/base', refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: Date.now });
  refresh.registerSpawnTarget({ pid: 100, agentId: 'codex', materializationKey: 'startup-cancellation',
    connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
      'openai-codex': { source: 'connected', profileId: 'work' },
    } } });
  const quota = new ConnectedServiceQuotasCoordinator({ api, credentials, quotaFetchers: [], discoveryEnabled: false,
    now: Date.now, randomBytes: length => new Uint8Array(length) });
  const common = { enabled: true, tickMs: 60_000, runImmediately: true, onTickError() {} };
  const loop = mode === 'refresh'
    ? startConnectedServiceRefreshLoop({ ...common,
      coordinator: createConnectedServiceRefreshLoopCoordinator({ coordinator: refresh, skipQualified: false }) })
    : startConnectedServiceQuotasLoop({ ...common,
      coordinator: createConnectedServiceQuotaLoopCoordinator({ coordinator: quota,
        ...(mode === 'quota-currentness' ? { isAccountRuntimeCurrent: async (signal?: AbortSignal) => {
          await fetchAccountEncryptionCurrentness({ token: credentials.token, signal });
          return true;
        } } : {}),
      }) });
  if (!loop) throw new Error('Missing startup loop');
  try {
    await requestEntered;
    const stopping = loop.stop();
    expect(requestSignal?.aborted, 'The startup adapter must carry Stop cancellation to Home I/O').toBe(true);
    await stopping;
    expect(activeReads).toBe(0);
    expect(reads).toBe(1);
  } finally {
    for (const release of releaseReads) release();
    await loop.stop();
  }
});

it('coalesces startup quota wakes until the failed Home admission is due again', async () => {
  vi.useFakeTimers();
  const beganAt = Date.now();
  const tickMs = 60_000;
  const credentials = { token: 'startup-quota-wake-fixture', encryption: null };
  const registry = new ConnectedServiceRuntimeRegistry();
  const attempts: number[] = [];
  const errors: unknown[] = [];
  let rejectFirstAdmission!: (reason: unknown) => void;
  const firstAdmission = new Promise<never>((_, reject) => { rejectFirstAdmission = reject; });
  const api = await ApiClient.create(credentials);
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') {
      attempts.push(Date.now() - beganAt);
      if (attempts.length === 1) return await firstAdmission;
      return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 0 } };
    }
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    throw new Error(`Unexpected startup quota read: ${path}`);
  });
  const quota = new ConnectedServiceQuotasCoordinator({ api, credentials, quotaFetchers: [], discoveryEnabled: false,
    now: Date.now, randomBytes: length => new Uint8Array(length) });
  const loop = startConnectedServiceQuotasLoop({
    enabled: true, tickMs, runImmediately: true, onTickError: error => { errors.push(error); },
    subscribeWake: listener => registry.subscribeTargetRegistrations(listener),
    coordinator: createConnectedServiceQuotaLoopCoordinator({ coordinator: quota,
      isAccountRuntimeCurrent: async (signal?: AbortSignal) => {
        await fetchAccountEncryptionCurrentness({ token: credentials.token, signal });
        return true;
      } }),
  })!;
  const registerTarget = (pid: number) => registry.registerTarget({ pid, agentId: null,
    materializationKey: `startup-quota-wake-${pid}`, connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} } });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([0]);
    for (let pid = 100; pid < 120; pid++) registerTarget(pid);
    rejectFirstAdmission(new DOMException('Home admission aborted', 'AbortError'));
    await vi.advanceTimersByTimeAsync(100);
    for (let pid = 120; pid < 140; pid++) registerTarget(pid);
    await vi.advanceTimersByTimeAsync(900);
    expect(errors).toHaveLength(1);
    expect(attempts, 'one startup attempt in the first second despite forty wakes').toEqual([0]);
    loop.pause();
    registerTarget(140);
    loop.resume();
    await vi.advanceTimersByTimeAsync(tickMs - 1_001);
    expect(attempts, 'the forced rerun also respects the failure deadline after resume').toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts, 'the due automatic and forced work share one admission').toEqual([0, tickMs]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toEqual([0, tickMs]);
    registerTarget(141);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts, 'ordinary wakes remain immediate after recovery').toEqual([0, tickMs, tickMs + 1_000]);
  } finally {
    await loop.stop();
    vi.useRealTimers();
  }
});
