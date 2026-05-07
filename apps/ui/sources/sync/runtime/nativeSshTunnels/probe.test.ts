import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_NATIVE_SSH_TUNNEL_PROBE_TIMEOUT_MS, probeNativeSshTunnel } from './probe';

describe('native SSH tunnel probe', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('classifies captive-portal HTTP responses distinctly from unreachable services', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 511,
            redirected: false,
            url: 'http://127.0.0.1:49152/health',
        })));

        await expect(probeNativeSshTunnel('http://127.0.0.1:49152')).resolves.toEqual({
            ok: false,
            reason: 'network-captive-portal',
        });
    });

    it('aborts hung health checks and reports the remote service as unreachable', async () => {
        vi.useFakeTimers();
        const fetchState: { signal?: AbortSignal } = {};
        vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
            fetchState.signal = init?.signal ?? undefined;
            return new Promise((_resolve, reject) => {
                fetchState.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        }));

        const result = probeNativeSshTunnel('http://127.0.0.1:49152');
        await vi.advanceTimersByTimeAsync(DEFAULT_NATIVE_SSH_TUNNEL_PROBE_TIMEOUT_MS);

        const signal = fetchState.signal;
        if (!signal) {
            throw new Error('probe did not pass an AbortSignal to fetch');
        }
        expect(signal.aborted).toBe(true);
        await expect(result).resolves.toEqual({
            ok: false,
            reason: 'remote-service-unreachable',
        });
    });
});
