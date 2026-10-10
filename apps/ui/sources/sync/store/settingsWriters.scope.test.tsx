import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

function observeApplySettings() {
    return vi.spyOn(getSyncSingleton(), 'applySettings');
}

import { useApplySettings } from './settingsWriters';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useApplySettings Account scope binding', () => {
    let previousState: ReturnType<typeof storage.getState>;
    let applySettings: ReturnType<typeof observeApplySettings>;
    type RuntimeState = {
        pendingSettings: Partial<Settings>;
        pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null;
        pendingSettingsDirty: boolean;
    };
    let runtime: RuntimeState;
    let previousRuntimeState: RuntimeState;

    beforeEach(async () => {
        previousState = storage.getState();
        await loadSyncSingletonForTests();
        // Observe the real writer; the fake clock holds its external persistence/network flush.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        applySettings = observeApplySettings();
        runtime = getSyncSingleton() as unknown as RuntimeState;
        previousRuntimeState = {
            pendingSettings: runtime.pendingSettings,
            pendingSettingsFlushTimer: runtime.pendingSettingsFlushTimer,
            pendingSettingsDirty: runtime.pendingSettingsDirty,
        };
        runtime.pendingSettings = {};
        runtime.pendingSettingsFlushTimer = null;
        runtime.pendingSettingsDirty = false;
        storage.setState((state) => ({
            ...state,
            settingsScope: { serverId: 'server-a', accountId: 'account-a' },
            settingsVersion: 1,
        }));
    });

    afterEach(() => {
        standardCleanup();
        applySettings?.mockRestore();
        vi.clearAllTimers();
        if (runtime) Object.assign(runtime, previousRuntimeState);
        vi.useRealTimers();
        storage.setState(previousState, true);
    });

    it('retains the rendered Account scope while a newly rendered writer binds the new scope', async () => {
        const hook = await renderHook(() => useApplySettings());
        const writerA = hook.getCurrent();

        await act(async () => {
            storage.setState((state) => ({
                ...state,
                settingsScope: { serverId: 'server-b', accountId: 'account-b' },
            }));
        });
        const writerB = hook.getCurrent();

        await act(async () => {
            writerA({ analyticsOptOut: true });
            writerB({ analyticsOptOut: false });
        });

        expect(writerB).not.toBe(writerA);
        expect(applySettings).toHaveBeenNthCalledWith(1, { analyticsOptOut: true }, {
            expectedSettingsScope: { serverId: 'server-a', accountId: 'account-a' },
            source: 'ui',
        });
        expect(applySettings).toHaveBeenNthCalledWith(2, { analyticsOptOut: false }, {
            expectedSettingsScope: { serverId: 'server-b', accountId: 'account-b' },
            source: 'ui',
        });
    });

    it('keeps a retained useSettingMutable setter bound to the Account that rendered it', async () => {
        const hook = await renderHook(() => useSettingMutable('sessionListSectionModeV1'));
        const setterA = hook.getCurrent()[1];

        await act(async () => {
            storage.setState((state) => ({
                ...state,
                settingsScope: { serverId: 'server-b', accountId: 'account-b' },
            }));
        });
        const setterB = hook.getCurrent()[1];

        await act(async () => {
            setterA('single');
            setterB('activity');
        });

        expect(setterB).not.toBe(setterA);
        expect(applySettings).toHaveBeenNthCalledWith(1, { sessionListSectionModeV1: 'single' }, {
            expectedSettingsScope: { serverId: 'server-a', accountId: 'account-a' },
            source: 'ui',
        });
        expect(applySettings).toHaveBeenNthCalledWith(2, { sessionListSectionModeV1: 'activity' }, {
            expectedSettingsScope: { serverId: 'server-b', accountId: 'account-b' },
            source: 'ui',
        });
    });

    it('applies a retained setting updater to the current Account value', async () => {
        storage.setState({ settings: settingsParse({}) });
        const hook = await renderHook(() => useSettingMutable('connectedServicesProviderStateSharingSettingsV1'));
        const setter = hook.getCurrent()[1];
        await act(async () => {
            storage.getState().applySettingsLocal({
                connectedServicesProviderStateSharingSettingsV1: {
                    ...storage.getState().settings.connectedServicesProviderStateSharingSettingsV1,
                    defaults: { configMode: 'copied', stateMode: 'isolated' },
                    byAgentId: { claude: { configMode: 'isolated' } },
                },
            });
        });

        await act(async () => {
            setter(current => ({ ...current, defaults: { ...current.defaults, stateMode: 'shared' } }));
        });

        expect(applySettings).toHaveBeenCalledWith({
            connectedServicesProviderStateSharingSettingsV1: expect.objectContaining({
                defaults: { configMode: 'copied', stateMode: 'shared' },
                byAgentId: { claude: { configMode: 'isolated' } },
            }),
        }, expect.objectContaining({ expectedSettingsScope: { serverId: 'server-a', accountId: 'account-a' } }));
    });

    it('does not evaluate a retained updater against a different Account', async () => {
        const hook = await renderHook(() => useSettingMutable('connectedServicesProviderStateSharingSettingsV1'));
        const setter = hook.getCurrent()[1];
        await act(async () => {
            storage.setState({ settingsScope: { serverId: 'server-b', accountId: 'account-b' } });
        });
        const update = vi.fn((current: Settings['connectedServicesProviderStateSharingSettingsV1']) => current);

        setter(update);

        expect(update).not.toHaveBeenCalled();
        expect(applySettings).not.toHaveBeenCalled();
    });

    it('does not write a setting updater that declines the current value', async () => {
        const hook = await renderHook(() => useSettingMutable('connectedServicesProviderStateSharingSettingsV1'));

        hook.getCurrent()[1](() => null);

        expect(applySettings).not.toHaveBeenCalled();
    });
});
