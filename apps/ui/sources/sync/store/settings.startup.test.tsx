import { expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { saveAccountSettings, saveActiveAccountSettingsScope } from '@/sync/domains/state/accountSettingsPersistence';

it('paints scoped settings before transport without acknowledging or activating the cached Account', async () => {
    const scope = { serverId: 'startup-home', accountId: 'startup-account' };
    const saved = settingsParse({ homeAtmosphere: { ...settingsDefaults.homeAtmosphere, source: 'picture' },
        analyticsOptOut: true, showLineNumbers: false });
    expect(saved.homeAtmosphere.source).toBe('picture');
    saveAccountSettings(scope, saved, 42);
    saveActiveAccountSettingsScope(scope);
    expect(getPersistenceStorage().getString('settings')).toBeUndefined();

    // Import the real store only after the native persistence boundary contains the cold-start cache.
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { useSetting, useSettingsReady, useSettingsVersion } = await import('./settingsReadHooks');
    const hook = await renderHook(() => ({ atmosphere: useSetting('homeAtmosphere'),
        analyticsOptOut: useSetting('analyticsOptOut'), showLineNumbers: useSetting('showLineNumbers'),
        ready: useSettingsReady(), version: useSettingsVersion() }));
    try {
        expect(hook.getCurrent()).toMatchObject({ atmosphere: { source: 'picture' },
            analyticsOptOut: true, showLineNumbers: false, ready: false, version: null });
        expect(storage.getState().settingsScope).toBeNull();
        expect(storage.getState().settingsRemoteAlertPolicyStatus).toBeNull();
        expect(getPersistenceStorage().getString('settings')).toBeUndefined();
    } finally {
        await hook.unmount();
        storage.getState().clearSettingsScope();
    }
});
