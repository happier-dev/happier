import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';

import { useSessionListStorageKind } from './useSessionListStorageKind';

const initialState = getStorage().getState();

afterEach(() => {
    standardCleanup();
    getStorage().setState(initialState, true);
});

describe('useSessionListStorageKind', () => {
    it.each(['persisted', 'direct'] as const)('combines sessions regardless of the previous %s tab', async (previousTab) => {
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'sessions.direct': true },
        });
        getStorage().getState().applyLocalSettings({ sessionsListStorageTab: previousTab });

        const hook = await renderHook(() => useSessionListStorageKind());

        expect(hook.getCurrent().directSessionsEnabled).toBe(true);
        expect(hook.getCurrent().storageKind).toBe('all');
        expect(getStorage().getState().localSettings.sessionsListStorageTab).toBe(previousTab);
        await hook.unmount();
    });

    it('excludes direct sessions when the feature is disabled', async () => {
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'sessions.direct': false },
        });
        getStorage().getState().applyLocalSettings({ sessionsListStorageTab: 'direct' });

        const hook = await renderHook(() => useSessionListStorageKind());

        expect(hook.getCurrent().directSessionsEnabled).toBe(false);
        expect(hook.getCurrent().storageKind).toBe('persisted');
        await hook.unmount();
    });
});
