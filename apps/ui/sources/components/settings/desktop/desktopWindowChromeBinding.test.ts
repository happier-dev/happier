import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopWindowChromeBinding } from './desktopWindowChromeBinding';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { subscribeDesktopWindowChromePolicy, type DesktopWindowChromePolicy } from '@/utils/platform/desktopWindowBridge';

const host = vi.hoisted(() => ({ invoke: vi.fn() }));
// Native desktop IPC is the system boundary; the real bridge, binding and publication remain active.
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
    desktopHostKind: () => 'electron',
    invokeDesktopHost: (command: string, args?: Record<string, unknown>) => host.invoke(command, args),
    listenDesktopHostEvent: async () => () => {},
}));
afterEach(() => host.invoke.mockReset());

const context = { isCurrent: () => true };

describe('native title bar Settings binding', () => {
    it('reads the native saved choice and publishes a restart-required change without writing UI settings', async () => {
        let policy: DesktopWindowChromePolicy = {
            strategy: 'native-windows-frame', canSetNativeTitleBar: true, useNativeTitleBar: false,
            nativeTitleBarRestartRequired: true,
        };
        host.invoke.mockImplementation(async (command: string) => command === 'desktop_get_window_chrome_policy'
            ? policy : (policy = { ...policy, useNativeTitleBar: true, nativeTitleBarRestartRequired: false }));
        expect(await desktopWindowChromeBinding.read()).toBe(false);
        const published: DesktopWindowChromePolicy[] = [];
        const unsubscribe = subscribeDesktopWindowChromePolicy(next => published.push(next));
        const writeLocal = vi.fn();
        try {
            expect(await desktopWindowChromeBinding.commit(localSettingsDefaults, true, writeLocal, context)).toBeUndefined();
            expect(await desktopWindowChromeBinding.read()).toBe(true);
            expect(published).toEqual([{ strategy: 'native-windows-frame', canSetNativeTitleBar: true, useNativeTitleBar: true }]);
            expect(writeLocal).not.toHaveBeenCalled();
            expect(host.invoke).toHaveBeenCalledWith('desktop_set_native_title_bar', { useNativeTitleBar: true });
        } finally { unsubscribe(); }
    });

    it('fails closed for an unsupported native owner and a retired invocation', async () => {
        host.invoke.mockResolvedValue({ strategy: 'custom-controls' });
        expect(await desktopWindowChromeBinding.read()).toBe(SETTING_VALUE_UNAVAILABLE);
        expect(await desktopWindowChromeBinding.commit(localSettingsDefaults, true, vi.fn(), context)).toBe(SETTING_VALUE_UNAVAILABLE);
        expect(await desktopWindowChromeBinding.commit(localSettingsDefaults, true, vi.fn(), { isCurrent: () => false })).toBe(SETTING_VALUE_UNAVAILABLE);
        expect(host.invoke.mock.calls.every(([command]) => command === 'desktop_get_window_chrome_policy')).toBe(true);
    });

    it('reports incomplete native persistence and allows a later retry through the same owner', async () => {
        let savingFails = true;
        host.invoke.mockImplementation(async (command: string) => command === 'desktop_get_window_chrome_policy'
            ? { strategy: 'custom-controls', canSetNativeTitleBar: true }
            : { strategy: 'custom-controls', canSetNativeTitleBar: true, useNativeTitleBar: !savingFails,
                ...(savingFails ? { nativeTitleBarPersistenceError: true } : { nativeTitleBarRestartRequired: true }) });
        expect(await desktopWindowChromeBinding.commit(localSettingsDefaults, true, vi.fn(), context)).toBe(SETTING_VALUE_UNAVAILABLE);
        savingFails = false;
        expect(await desktopWindowChromeBinding.commit(localSettingsDefaults, true, vi.fn(), context)).toBeUndefined();
    });
});
