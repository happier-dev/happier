import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { ApiClient } from '@/api/api';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';
import { startConnectedServiceRefreshLoop } from './startConnectedServiceRefreshLoop';

describe('connected-service refresh shared work cancellation', () => {
    it('ends the stopped loop join while its manual owner retains the HTTP request', async () => {
        vi.useFakeTimers();
        const credentials = { token: 'manual-refresh-cancellation-fixture', encryption: null };
        const api = await ApiClient.create(credentials);
        let entered!: () => void;
        const requestEntered = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        let requestSignal: AbortSignal | undefined;
        let manualReadPending = true;
        let modeReads = 0;
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (!String(url).endsWith('/v1/account/encryption')) return { status: 404, data: null };
            modeReads++;
            requestSignal = config?.signal as AbortSignal | undefined;
            entered();
            await new Promise<void>(resolve => { release = resolve; });
            manualReadPending = false;
            return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        });
        const coordinator = new ConnectedServiceRefreshCoordinator({
            api, credentials, machineIdProvider: () => 'fixture-machine',
            activeServerDir: '/fixture/active', baseDir: '/fixture/base',
            refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: Date.now,
        });
        coordinator.registerSpawnTarget({
            pid: 100, agentId: 'codex', materializationKey: 'fixture',
            connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
                'openai-codex': { source: 'connected', profileId: 'work' },
            } },
        });
        const manual = coordinator.refreshConnectedServiceCredentialForSpawnPreflight({ serviceId: 'openai-codex', profileId: 'work' });
        void manual.catch(() => {});
        let loop: ReturnType<typeof startConnectedServiceRefreshLoop> = null;
        try {
            await requestEntered;
            loop = startConnectedServiceRefreshLoop({
                enabled: true, tickMs: 30_000, coordinator,
                runImmediately: true, onTickError: () => {},
            });
            await vi.advanceTimersByTimeAsync(0);
            let stopped = false;
            const stopping = loop!.stop().then(() => { stopped = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(stopped).toBe(true);
            expect(modeReads).toBe(1);
            expect(manualReadPending).toBe(true);
            expect(requestSignal?.aborted ?? false).toBe(false);
            await stopping;
        } finally {
            release?.();
            await manual;
            await loop?.stop();
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });
});
