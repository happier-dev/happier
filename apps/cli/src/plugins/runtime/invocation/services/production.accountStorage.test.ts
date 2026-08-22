import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

import type { StablePluginAccountStorageHost } from '@/plugins/runtime/context/storage';
import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import { createProductionPluginInvocationServiceOwners } from './production';

describe('production Account Collections invocation binding', () => {
    it('vends Account Data only through the declared and selected storage.account policy', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-production-account-storage-'));
        const account = Object.freeze({ marker: 'account_data_host_bound' }) as unknown as PluginAccountStorageScope;
        const bind = vi.fn<StablePluginAccountStorageHost['bind']>(() => account);
        const accountStorage: StablePluginAccountStorageHost = Object.freeze({ bind });
        let disposeOwners: (() => Promise<void>) | undefined;

        try {
            // The Data host is a genuine cross-process boundary; this test proves
            // production invocation preserves the exact scope it binds.
            const optionalRequest = {
                id: 'optional-account-state',
                capability: 'storage.account' as const,
                reason: 'Read optional Account collection state',
                scope: { enabled: true as const },
            };
            const selectedOptionalAccess = createDefaultPluginAccessScopeRegistry().createSelection({
                pluginId: 'happier.channels',
                accessId: optionalRequest.id,
                capability: optionalRequest.capability,
                scope: optionalRequest.scope,
                selectedAtMs: 1,
            });
            let optionalAccess = [] as readonly typeof selectedOptionalAccess[];
            const ownerParams = Object.freeze({
                loggerSink: { write: () => {} },
                storagePaths: resolvePluginStorePaths({ happyHomeDir }),
                accountStorage,
                resolveOptionalAccess: () => optionalAccess,
            });
            const owners = createProductionPluginInvocationServiceOwners(ownerParams);
            const unavailableProducerOwners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write: () => {} },
                storagePaths: resolvePluginStorePaths({ happyHomeDir }),
            });
            disposeOwners = async () => {
                await unavailableProducerOwners.dispose();
                await owners.dispose();
            };
            const signal = new AbortController().signal;
            const seed = Object.freeze({
                plugin: Object.freeze({ id: 'happier.channels', version: '0.0.0' }),
                contribution: Object.freeze({
                    id: 'provider/observation-ingest-v1',
                    qualifiedId: 'happier.channels/actions/provider/observation-ingest-v1',
                }),
                generation: '7',
                correlationId: 'channels-account-data-binding',
                surface: 'plugin' as const,
                signal,
                isGenerationCurrent: () => true,
            });
            const requiredRequest = {
                id: 'account-state',
                capability: 'storage.account' as const,
                reason: 'Read the plugin\'s declared Account collection',
                scope: { enabled: true as const },
            };
            const target = {
                pluginId: seed.plugin.id,
                generation: seed.generation,
                qualifiedId: seed.contribution.qualifiedId,
            };
            const requiredPolicy = owners.resolveInvocationHostPolicy(target, {
                hostAccessRequests: [{ request: requiredRequest, required: true }],
                surface: seed.surface,
                signal,
            });
            optionalAccess = [selectedOptionalAccess];
            const selectedOptionalPolicy = owners.resolveInvocationHostPolicy(target, {
                hostAccessRequests: [{ request: optionalRequest, required: false }],
                surface: seed.surface,
                signal,
            });
            optionalAccess = [];
            const unselectedOptionalPolicy = owners.resolveInvocationHostPolicy(target, {
                hostAccessRequests: [{ request: optionalRequest, required: false }],
                surface: seed.surface,
                signal,
            });
            const unavailableProducerPolicy = unavailableProducerOwners.resolveInvocationHostPolicy(target, {
                hostAccessRequests: [{ request: requiredRequest, required: true }],
                surface: seed.surface,
                signal,
            });
            const requiredServices = owners.createServices(seed, requiredPolicy.serviceBinding);
            const selectedOptionalServices = owners.createServices(Object.freeze({
                ...seed,
                correlationId: 'channels-account-data-selected-optional-binding',
            }), selectedOptionalPolicy.serviceBinding);
            const unselectedOptionalServices = owners.createServices(Object.freeze({
                ...seed,
                correlationId: 'channels-account-data-unselected-optional-binding',
            }), unselectedOptionalPolicy.serviceBinding);
            const unavailableProducerServices = unavailableProducerOwners.createServices(Object.freeze({
                ...seed,
                correlationId: 'channels-account-data-unavailable-producer-binding',
            }), unavailableProducerPolicy.serviceBinding);
            const ordinary = owners.createServices(Object.freeze({
                ...seed,
                correlationId: 'channels-account-data-ordinary-binding',
            }), owners.createOrdinaryServiceBinding(
                seed.generation,
                'channels-account-data-ordinary-binding',
            ));

            expect(requiredPolicy.hostAccess).toEqual([expect.objectContaining({
                id: requiredRequest.id,
                status: 'available',
            })]);
            expect(selectedOptionalPolicy.hostAccess).toEqual([expect.objectContaining({
                id: optionalRequest.id,
                status: 'available',
            })]);
            expect(unselectedOptionalPolicy.hostAccess).toEqual([expect.objectContaining({
                id: optionalRequest.id,
                status: 'denied',
                code: 'plugin_host_access_resource_not_selected',
            })]);
            expect(unavailableProducerPolicy.hostAccess).toEqual([expect.objectContaining({
                id: requiredRequest.id,
                status: 'unavailable',
                code: 'plugin_host_access_service_unavailable',
            })]);
            expect(bind).toHaveBeenCalledTimes(2);
            expect(bind).toHaveBeenNthCalledWith(1, expect.objectContaining({
                pluginId: 'happier.channels',
                generation: '7',
                signal,
            }));
            expect(requiredServices.storage.account).toBe(account);
            expect(selectedOptionalServices.storage.account).toBe(account);
            expect(unselectedOptionalServices.storage.account).toBeUndefined();
            expect(unavailableProducerServices.storage.account).toBeUndefined();
            expect(ordinary.storage.account).toBeUndefined();
            bind.mockReturnValueOnce(null);
            const unavailableAtActivationServices = owners.createServices(Object.freeze({
                ...seed,
                correlationId: 'channels-account-data-unavailable-at-activation',
            }), requiredPolicy.serviceBinding);
            expect(unavailableAtActivationServices.storage.account).toBeUndefined();
            expect(bind).toHaveBeenCalledTimes(3);
            await unselectedOptionalServices.storage.daemon.set('unselected-account-access', true);
            await expect(unselectedOptionalServices.storage.daemon.get('unselected-account-access')).resolves.toBe(true);
            await ordinary.storage.daemon.set('ordinary-account-access', true);
            await expect(ordinary.storage.daemon.get('ordinary-account-access')).resolves.toBe(true);
            expect(ordinary.availability('storage')).toEqual({ status: 'available' });
        } finally {
            await disposeOwners?.();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
