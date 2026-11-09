import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceCredentialHttpClient } from './connectedServiceCredentialApi';

afterEach(() => vi.restoreAllMocks());

describe('connected-service profile HTTP cancellation', () => {
    it('cancels a joined reader while the discovery owner keeps its HTTP request', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let entered!: () => void;
        const requestEntered = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        let pending = true;
        let requestSignal: AbortSignal | undefined;
        vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
            requestSignal = config?.signal as AbortSignal | undefined;
            entered();
            await new Promise<void>(resolve => { release = resolve; });
            pending = false;
            return { status: 200, data: { serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected' }] } };
        });
        const api = new ConnectedServiceCredentialHttpClient({ token: 'profiles-owner-fixture' });
        const owner = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });
        await requestEntered;
        const reader = api.listConnectedServiceProfiles({ serviceId: 'openai-codex', ...{ signal: controller.signal } });
        let readerRetired = false;
        const settlement = reader.then(() => {}, () => { readerRetired = true; });
        try {
            controller.abort();
            await vi.advanceTimersByTimeAsync(0);
            expect(readerRetired).toBe(true);
            expect(pending).toBe(true);
            expect(requestSignal?.aborted ?? false).toBe(false);
            release();
            await expect(owner).resolves.toMatchObject({ profiles: [{ profileId: 'work', status: 'connected' }] });
        } finally {
            release?.();
            await Promise.allSettled([owner, settlement]);
            vi.useRealTimers();
        }
    });

    it('aborts an active discovery read through the owning API', async () => {
        const controller = new AbortController();
        let entered!: () => void;
        const requestEntered = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        let requestSignal: AbortSignal | undefined;
        vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
            requestSignal = config?.signal as AbortSignal | undefined;
            entered();
            return await new Promise((_resolve, reject) => {
                release = () => reject(new Error('fixture released'));
                requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
            });
        });
        const api = new ConnectedServiceCredentialHttpClient({ token: 'profiles-cancellation-fixture' });
        const request = api.listConnectedServiceProfiles({ serviceId: 'openai-codex', ...{ signal: controller.signal } });
        void request.catch(() => {});
        try {
            await requestEntered;
            controller.abort();
            expect(requestSignal?.aborted).toBe(true);
            await expect(request).rejects.toBe(controller.signal.reason);
        } finally {
            release?.();
            await request.catch(() => {});
        }
    });
});
