import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const machineRpc = vi.hoisted(() => vi.fn());

// Native presentation is not rendered by this hook test. Keep its SDK outside
// the collected graph; all internal settings/projection logic remains real.
vi.mock('phosphor-react-native', () => new Proxy({}, {
    has: () => true,
    get: (_target, name) => name === 'then' ? undefined : () => null,
}));

// The network is the system boundary. Applied transport state, settings,
// subscriptions, Account lifetime, cache and mounted readers stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
const { forgetPluginUiProjectionAdmissionSnapshots, readPluginUiProjectionAdmissionSnapshot } = await import('@/sync/domains/plugins/ui/projectionWarmCache');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const { resolvePluginUiText } = await import('@/sync/domains/plugins/ui/i18n');
const { usePluginUiProjectionCurrentness, PLUGIN_UI_SECTIONS } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
const { getPreferredLanguage, preloadTranslations } = await import('@/text');
const { clearDaemonMergedProjectionCacheForTests } = await import('./loadDaemonMergedProjectionInputs');
const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');

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
        await homes.reset();
        accountScope.serverId = await homes.addHome({ name: 'Locale Home', serverUrl: 'https://locale.example.test', accountId: accountScope.accountId });
        await prepareWarmCacheEncryptionKey();
        // Locale activation waits for its platform bundle; test the projection
        // refresh independently of the worker's first translation compilation.
        await preloadTranslations('fr');
        retireActiveServerAccountScopeLifetime();
        clearDaemonMergedProjectionCacheForTests();
        forgetPluginUiProjectionAdmissionSnapshots(accountScope);
        storage.setState({
            profileScope: accountScope, settingsScope: accountScope, settingsVersion: null,
            settings: { ...settingsDefaults }, endpointStatus: 'online',
            machines: { 'machine-1': createMachineFixture({ activeAt: Date.now() }) },
        });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        applyRemoteLanguage('en', 1);
        machineRpc.mockReset();
        machineRpc.mockImplementation(async ({ payload }: { payload: { locale: string } }) => ({
            protocolVersion: 1,
            projection: localeProjection(payload.locale),
        }));
    });

    afterEach(async () => {
        standardCleanup();
        publishAppliedActiveServerRuntimeAvailability(false);
        retireActiveServerAccountScopeLifetime();
        clearDaemonMergedProjectionCacheForTests();
        await homes.reset();
    });

    it('describes each Machine revision once across mounted projection callers and ignores unrelated revision pushes', async () => {
        storage.setState({ machines: {
            ...storage.getState().machines,
            'machine-2': createMachineFixture({ id: 'machine-2', activeAt: Date.now() }),
        } });
        let generation = 41;
        machineRpc.mockImplementation(async ({ payload }: { payload: { locale: string } }) => ({
            protocolVersion: 1,
            projection: { ...localeProjection(payload.locale), generation },
        }));
        const usePresentedProjection = (machineId: string) => ({
            currentness: usePluginUiProjectionCurrentness({ machineId }),
            merged: useDaemonMergedProjectionInputs({ sections: PLUGIN_UI_SECTIONS, machineId }),
        });
        const first = await renderHook(() => usePresentedProjection('machine-1'));
        const second = await renderHook(() => usePresentedProjection('machine-2'));
        await vi.waitFor(() => {
            expect(first.getCurrent().merged.phase).toBe('ready');
            expect(second.getCurrent().merged.phase).toBe('ready');
            expect(first.getCurrent().currentness.phase).toBe('current');
            expect(second.getCurrent().currentness.phase).toBe('current');
        });
        const counts = () => ['machine-1', 'machine-2'].map(machineId => machineRpc.mock.calls
            .filter(([request]) => request.payload.machineId === machineId).length);
        expect(counts()).toEqual([1, 1]);
        const lateSubscriber = await renderHook(() => usePresentedProjection('machine-1'));
        await vi.waitFor(() => expect(lateSubscriber.getCurrent().merged.phase).toBe('ready'));
        expect(counts()).toEqual([1, 1]);
        const unchanged = first.getCurrent().merged.inputs;
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({
            machineId: 'unrelated-machine', serverId: accountScope.serverId,
        }, 'refresh'));
        await flushHookEffects();
        expect(counts()).toEqual([1, 1]);
        generation = 42;
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({
            machineId: 'machine-2', serverId: accountScope.serverId,
        }, 'refresh'));
        await vi.waitFor(() => expect(second.getCurrent().merged.inputs?.pluginProjectionV2?.generation).toBe(42));
        expect(counts()).toEqual([1, 2]);
        expect(first.getCurrent().merged.inputs).toBe(unchanged);
        await lateSubscriber.unmount();
        await second.unmount();
        await first.unmount();
    });

    it('refreshes mounted successful readers after a remote language update and preserves unrelated-setting identities', async () => {
        const hook = await renderHook(() => ({
            currentness: usePluginUiProjectionCurrentness({ machineId: 'machine-1' }),
            merged: useDaemonMergedProjectionInputs({ sections: PLUGIN_UI_SECTIONS, machineId: 'machine-1' }),
        }));
        await vi.waitFor(() => {
            expect(hook.getCurrent().currentness).toEqual(expect.objectContaining({ phase: 'current' }));
            expect(hook.getCurrent().merged.phase).toBe('ready');
        });
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
            ...storage.getState().settings, analyticsOptOut: !storage.getState().settings.analyticsOptOut,
        }, 3));
        await flushHookEffects();
        expect(hook.getCurrent().merged.inputs).toBe(frenchInputs);
        expect(hook.getCurrent().currentness.pluginUiProjection).toBe(frenchUi);
        expect(machineRpc.mock.calls.length).toBe(requests);
        await hook.unmount();
    });
});
