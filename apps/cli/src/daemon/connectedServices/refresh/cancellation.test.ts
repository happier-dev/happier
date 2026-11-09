import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '@/api/api';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { acquireQualifiedConnectedAccountRefreshLeaseV4, mutateQualifiedConnectedAccountCredentialHealthV4, mutateQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';
import { startConnectedServiceRefreshLoop } from './startConnectedServiceRefreshLoop';

afterEach(() => vi.restoreAllMocks());

describe('connected-service refresh cancellation', () => {
    it.each(['lease', 'credential', 'health'] as const)('cancels the %s mutation HTTP request', async operation => {
        const controller = new AbortController();
        let entered!: () => void;
        const requestEntered = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        let requestSignal: AbortSignal | undefined;
        const blockRequest = async (_url: unknown, _payload: unknown, config?: { signal?: unknown }): Promise<never> => {
            requestSignal = config?.signal as AbortSignal | undefined;
            entered();
            return await new Promise((_resolve, reject) => {
                release = () => reject(new Error('fixture released'));
                requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
            });
        };
        vi.spyOn(axios, 'post').mockImplementation(blockRequest);
        vi.spyOn(axios, 'patch').mockImplementation(blockRequest);
        const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
        const expectedCredentialRevision = 'csr_abcdefghijklmnopqrstuv';
        const transport = { token: 'refresh-cancellation-fixture', signal: controller.signal };
        const request = operation === 'lease'
            ? acquireQualifiedConnectedAccountRefreshLeaseV4({ ...transport, lease: {
                ref, expectedCredentialRevision, ownerId: 'fixture-machine', ttlMs: 30_000,
            } })
            : operation === 'credential'
                ? mutateQualifiedConnectedAccountCredentialV4({ ...transport, mutation: {
                    ref, expectedCredentialRevision, expectedConfigurationRevision: null, authenticationModeId: 'token',
                    content: { t: 'plain', v: { token: 'fixture' } }, metadata: { scopes: [] },
                } })
                : mutateQualifiedConnectedAccountCredentialHealthV4({ ...transport, patch: {
                    ref, expectedCredentialRevision, expectedConfigurationRevision: null,
                    health: { v: 1, status: 'connected' },
                } });
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

    it.each(['independent', 'shared scheduled'] as const)('cancels the %s admission HTTP read', async kind => {
        const controller = new AbortController();
        let entered!: () => void;
        const requestEntered = new Promise<void>(resolve => { entered = resolve; });
        const release = new Set<() => void>();
        let requestSignal: AbortSignal | undefined;
        vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
            requestSignal = config?.signal as AbortSignal | undefined;
            entered();
            return await new Promise((_resolve, reject) => {
                release.add(() => reject(new Error('fixture released')));
                requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
            });
        });
        const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
            reloadController: pluginReloadController,
            credentials: { token: 'refresh-cancellation-fixture', encryption: null },
            isAccountRuntimeCurrent: async signal => {
                await fetchAccountEncryptionCurrentness({ token: 'refresh-cancellation-fixture', signal });
                return true;
            },
            getAccountEncryptionMode: async () => 'plain',
            // Persistent configuration is a system boundary, unused before admission.
            configuration: { read: async () => null, secrets: {
                admit: async () => undefined, has: async () => false, read: async () => null,
            } },
        });
        const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
        const read = kind === 'independent'
            ? owner.readCredentialRevision({ account, signal: controller.signal })
            : owner.invokeScheduledWithReceipts({ account, signal: controller.signal, quota: { signal: controller.signal } });
        void read.catch(() => {});
        try {
            await requestEntered;
            controller.abort();
            expect(requestSignal?.aborted).toBe(true);
            await read.catch(() => {});
        } finally {
            for (const reject of release) reject();
            await read.catch(() => {});
        }
    });

    it.each(['mode', 'credential'] as const)('aborts the active %s HTTP read before Stop settles', async phase => {
        const credentials = { token: 'refresh-cancellation-fixture', encryption: null };
        const api = await ApiClient.create(credentials);
        let entered!: () => void;
        const requestEntered = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        let requestSignal: AbortSignal | undefined;
        let aborted = false;
        // Axios is the Home HTTP boundary; coordinator and API behavior remain real.
        vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
            const modeRead = String(_url).endsWith('/v1/account/encryption');
            if (modeRead && phase === 'credential') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (!modeRead && phase === 'mode') return { status: 404, data: null };
            requestSignal = config?.signal as AbortSignal | undefined;
            entered();
            await new Promise<void>((resolve, reject) => {
                release = resolve;
                requestSignal?.addEventListener('abort', () => {
                    aborted = true;
                    reject(requestSignal?.reason);
                }, { once: true });
            });
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
        const loop = startConnectedServiceRefreshLoop({
            enabled: true, tickMs: 30_000, coordinator,
            runImmediately: true, onTickError: () => {},
        })!;
        try {
            await requestEntered;
            const stopped = loop.stop();
            // Abort dispatch is synchronous; no wall-clock race or forced settlement.
            expect(requestSignal?.aborted).toBe(true);
            expect(aborted).toBe(true);
            await stopped;
        } finally {
            release?.();
            await loop.stop();
        }
    });
});
