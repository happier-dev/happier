import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const machineRpc = vi.hoisted(() => vi.fn());

// Native presentation is not rendered by this hook test. Keep its SDK outside
// the collected graph; all internal settings/projection logic remains real.
vi.mock('phosphor-react-native', () => new Proxy({}, {
    has: () => true,
    get: (_target, name) => name === 'then' ? undefined : () => null,
}));

// The network and presence of an applied transport are system boundaries.
// Settings, subscriptions, Account lifetime, cache and mounted readers stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://locale.example.test', generation: 1 }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));

import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { forgetPluginUiProjectionAdmissionSnapshots, readPluginUiProjectionAdmissionSnapshot } from '@/sync/domains/plugins/ui/projectionWarmCache';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { getPreferredLanguage } from '@/text';
import { clearDaemonMergedProjectionCacheForTests } from './loadDaemonMergedProjectionInputs';
import { useDaemonMergedProjectionInputs } from './useDaemonMergedProjectionInputs';

const accountScope = { serverId: 'server-1', accountId: 'account-locale-mounted' };

function localeProjection(locale: string) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 41,
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'translations:acme.locale': {
                        id: 'translations:acme.locale', pluginId: 'acme.locale',
                        occurrenceId: 'locale-occurrence', contributionKind: 'translations',
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

function applyRemoteLanguage(preferredLanguage: 'en' | 'fr', version: number) {
    storage.getState().applySettingsForScope(accountScope, { ...storage.getState().settings, preferredLanguage }, version);
}

describe('mounted locale-narrowed daemon projection readers', () => {
    beforeEach(async () => {
        await prepareWarmCacheEncryptionKey();
        retireActiveServerAccountScopeLifetime();
        clearDaemonMergedProjectionCacheForTests();
        forgetPluginUiProjectionAdmissionSnapshots(accountScope);
        storage.setState({
            profileScope: accountScope, settingsScope: accountScope, settingsVersion: null,
            settings: { ...settingsDefaults }, endpointStatus: 'online',
            machines: { 'machine-1': createMachineFixture({ activeAt: Date.now() }) },
        });
        applyRemoteLanguage('en', 1);
        machineRpc.mockReset();
        machineRpc.mockImplementation(async ({ payload }: { payload: { locale: string } }) => ({
            protocolVersion: 1,
            projection: localeProjection(payload.locale),
        }));
    });

    afterEach(() => {
        standardCleanup();
        retireActiveServerAccountScopeLifetime();
        clearDaemonMergedProjectionCacheForTests();
    });

    it('refreshes mounted successful readers after a remote language update and preserves unrelated-setting identities', async () => {
        const hook = await renderHook(() => ({
            currentness: usePluginUiProjectionCurrentness({ machineId: 'machine-1' }),
            merged: useDaemonMergedProjectionInputs({ machineId: 'machine-1' }),
        }));
        await vi.waitFor(() => expect(hook.getCurrent().currentness.phase).toBe('current'));
        expect(hook.getCurrent().merged.phase).toBe('ready');
        expect(translatedTitle(hook.getCurrent().currentness.pluginUiProjection)).toBe('Hello');
        const englishInputs = hook.getCurrent().merged.inputs;
        const englishUi = hook.getCurrent().currentness.pluginUiProjection;

        await act(async () => applyRemoteLanguage('fr', 2));
        await flushHookEffects();
        await vi.waitFor(() => {
            expect(hook.getCurrent().currentness.phase).toBe('current');
            expect(translatedTitle(hook.getCurrent().currentness.pluginUiProjection)).toBe('Bonjour');
            expect(hook.getCurrent().merged.phase).toBe('ready');
            const projection = hook.getCurrent().merged.inputs?.pluginProjectionV2;
            if (!projection) throw new Error('Expected ready merged plugin projection');
            expect(translatedTitle(normalizePluginUiProjection(projection))).toBe('Bonjour');
        });
        expect(hook.getCurrent().merged.inputs).not.toBe(englishInputs);
        expect(hook.getCurrent().currentness.pluginUiProjection).not.toBe(englishUi);
        const retained = readPluginUiProjectionAdmissionSnapshot({ scope: accountScope, targetKey: 'default:machine-1', machineId: 'machine-1' });
        expect(translatedTitle(retained)).toBe('Bonjour');

        const frenchInputs = hook.getCurrent().merged.inputs;
        const frenchUi = hook.getCurrent().currentness.pluginUiProjection;
        const requests = machineRpc.mock.calls.length;
        await act(async () => storage.getState().applySettingsForScope(accountScope, {
            ...storage.getState().settings, viewInline: !storage.getState().settings.viewInline,
        }, 3));
        await flushHookEffects();
        expect(hook.getCurrent().merged.inputs).toBe(frenchInputs);
        expect(hook.getCurrent().currentness.pluginUiProjection).toBe(frenchUi);
        expect(machineRpc.mock.calls.length).toBe(requests);
        await hook.unmount();
    });
});
