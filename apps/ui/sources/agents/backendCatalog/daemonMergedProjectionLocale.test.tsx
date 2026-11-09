import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const machineRpc = vi.hoisted(() => vi.fn());

// The network is the system boundary. Applied transport state, settings,
// subscriptions, Account lifetime, cache and both readers stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

import type { StorageState } from '@/sync/store/types';
import { storage } from '@/sync/domains/state/storageStore';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { forgetPluginUiProjectionAdmissionSnapshots } from '@/sync/domains/plugins/ui/projectionWarmCache';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings } from '@/text';
import {
    clearDaemonMergedProjectionCacheForTests,
    loadDaemonMergedProjectionCacheEntry,
    readReusableDaemonMergedProjectionCacheEntry,
} from './loadDaemonMergedProjectionInputs';

let accountScope = { serverId: 'server-1', accountId: 'account-locale' };
let accountNumber = 0;

function localeProjection(locale: string) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 41,
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'translations:acme.locale': {
                        id: 'translations:acme.locale',
                        pluginId: 'acme.locale',
                        occurrenceId: 'locale-occurrence',
                        contributionKind: 'translations',
                        locales: locale === 'en' ? ['en'] : ['en', locale],
                        bundles: { en: { title: 'Hello' }, ...(locale === 'fr' ? { fr: { title: 'Bonjour' } } : {}) },
                    },
                },
            },
        },
    });
}

function translatedTitle(projection: Parameters<typeof resolvePluginUiText>[0]['projection']) {
    return resolvePluginUiText({ projection, pluginId: 'acme.locale', key: 'title', locale: getPreferredLanguage() });
}

describe('locale-narrowed daemon projection readers', () => {
    beforeEach(async () => {
        await prepareWarmCacheEncryptionKey();
        retireActiveServerAccountScopeLifetime();
        clearDaemonMergedProjectionCacheForTests();
        accountScope = { serverId: 'server-1', accountId: `account-locale-${++accountNumber}` };
        forgetPluginUiProjectionAdmissionSnapshots(accountScope);
        // The bridge is populated with the exact fixture fields this owner reads;
        // the cache and Account lifetime still use their real reader logic.
        const state = {
            ...storage.getState(),
            profileScope: accountScope,
            machines: { 'machine-1': createMachineFixture({ activeAt: Date.now() }) },
        } satisfies StorageState;
        registerStorageStateReader(() => state);
        publishAppliedActiveServerSnapshot({ serverId: accountScope.serverId, serverUrl: 'https://locale.example.test', generation: accountNumber });
        // Locale changes commit only after their lazy translation bundle is ready.
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('en');
        machineRpc.mockReset();
        machineRpc.mockImplementation(async ({ payload }: { payload: { locale: string } }) => ({
            protocolVersion: 1,
            projection: localeProjection(payload.locale),
        }));
    });

    afterEach(() => {
        standardCleanup();
        publishAppliedActiveServerRuntimeAvailability(false);
        retireActiveServerAccountScopeLifetime();
        clearDaemonMergedProjectionCacheForTests();
    });

    it('does not join an older-locale request or let its late answer replace the current-locale cache', async () => {
        let completeEnglish!: (value: { protocolVersion: number; projection: ReturnType<typeof localeProjection> }) => void;
        machineRpc.mockImplementationOnce(() => new Promise((resolve) => { completeEnglish = resolve; }));
        const english = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1' });
        await vi.waitFor(() => expect(completeEnglish).toBeTypeOf('function'));
        setPreferredLanguageFromSettings('fr');
        expect(getPreferredLanguage()).toBe('fr');
        const pendingFrench = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', reuseFreshReady: true });
        await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) => request.payload.locale === 'fr')).toBe(true));
        const french = await pendingFrench;
        expect(french?.kind).toBe('ready');
        expect(translatedTitle(normalizePluginUiProjection(french?.kind === 'ready' ? french.inputs.pluginProjectionV2 : null))).toBe('Bonjour');
        completeEnglish({ protocolVersion: 1, projection: localeProjection('en') });
        await english;
        expect(readReusableDaemonMergedProjectionCacheEntry({ machineId: 'machine-1' })).toBe(french);
    });

    it('captures the request locale before asynchronous platform capability resolution', async () => {
        const english = loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1' });
        setPreferredLanguageFromSettings('fr');
        await english;
        expect(machineRpc.mock.calls[0]?.[0].payload.locale).toBe('en');
    });
});
