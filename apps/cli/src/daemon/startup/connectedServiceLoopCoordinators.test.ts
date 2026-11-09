import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '@/api/api';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { startConnectedServiceRefreshLoop } from '../connectedServices/refresh/startConnectedServiceRefreshLoop';
import { startConnectedServiceQuotasLoop } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
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
