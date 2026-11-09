import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import type { StablePluginAccountStorageHost } from '@/plugins/runtime/context/storage';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createProductionPluginInvocationServiceOwners } from './production';

describe('production Account Collections invocation binding', () => {
    it('uses the captured Account host without making manifest declarations a second grant', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-production-account-storage-'));
        // The Account data host is a cross-process boundary; its returned scope
        // stands for the Account authority established outside plugin declarations.
        const account = Object.freeze({ marker: 'captured-account' }) as unknown as PluginAccountStorageScope;
        let currentAccount: PluginAccountStorageScope | null = account;
        const accountStorage: StablePluginAccountStorageHost = { bind: () => currentAccount };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} }, storagePaths: resolvePluginStorePaths({ happyHomeDir }), accountStorage,
        });
        const unavailableOwner = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} }, storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const seed = {
            plugin: { id: 'happier.channels', version: '0.0.0' },
            contribution: { id: 'run', qualifiedId: 'happier.channels/actions/run' },
            occurrenceId: '7', correlationId: 'captured-account', surface: 'plugin' as const,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        };
        try {
            const optional = owners.resolveInvocationHostPolicy({
                pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, qualifiedId: seed.contribution.qualifiedId,
            }, { surface: seed.surface, hostAccessRequests: [{ required: false, request: {
                id: 'account-storage', capability: 'storage.account', reason: 'Persist Account state', scope: { enabled: true },
            } }] });
            const selected = owners.createServices(seed, optional.serviceBinding);
            const ordinary = owners.createServices({ ...seed, correlationId: 'ordinary-account' },
                owners.createOrdinaryServiceBinding(seed.occurrenceId, 'ordinary-account'));
            expect(selected.storage.account).toBe(account);
            expect(ordinary.storage.account).toBe(account);
            await ordinary.storage.daemon.set('local-state', true);
            await expect(ordinary.storage.daemon.get('local-state')).resolves.toBe(true);
            currentAccount = null;
            const unavailable = owners.createServices({ ...seed, correlationId: 'withdrawn-account' }, optional.serviceBinding);
            expect(unavailable.storage.account).toBeUndefined();
            const missingHost = unavailableOwner.createServices(seed,
                unavailableOwner.createOrdinaryServiceBinding(seed.occurrenceId, 'missing-account'));
            expect(missingHost.storage.account).toBeUndefined();
        } finally {
            await owners.dispose();
            await unavailableOwner.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
