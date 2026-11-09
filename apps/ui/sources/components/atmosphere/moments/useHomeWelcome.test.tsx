import * as React from 'react';
import { act } from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { useHomeWelcome, type HomeWelcome } from './useHomeWelcome';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { onboardingHistoryState } from '@/sync/domains/state/onboardingUiState';
import { resetPersistentUiStateForTest } from '@/dev/testkit/cleanup/persistentUiState';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function Home(props: Readonly<{ eligible: boolean; loadingShown?: boolean; reducedMotion?: boolean; seen: HomeWelcome[] }>) {
    const welcome = useHomeWelcome({ eligible: props.eligible, loadingShown: props.loadingShown ?? false,
        reducedMotion: props.reducedMotion ?? false, writing: false });
    props.seen.push(welcome);
    return <View testID="home" />;
}

describe('Home Welcome planet', () => {
    let previous: ReturnType<typeof storage.getState>;
    beforeEach(async () => {
        await resetPersistentUiStateForTest();
        previous = storage.getState();
        storage.setState(state => ({ ...state,
            settings: settingsParse({ actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }),
            localSettings: { ...localSettingsDefaults } }));
    });
    afterEach(async () => {
        await act(async () => { storage.setState(previous, true); });
    });

    it('plays once and remembers the arrival on this device even with Settings writes Off', async () => {
        const mmkv = getPersistenceStorage();
        const writes = vi.spyOn(mmkv, 'set');
        const localSettings = storage.getState().localSettings;
        const first: HomeWelcome[] = [];
        const screen = await renderScreen(<Home eligible={false} seen={first} />);
        expect(first.some(welcome => welcome.playing)).toBe(false);
        await screen.update(<Home eligible seen={first} />);
        expect(first.at(-1)?.playing).toBe(true);
        expect(writes.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
        expect(storage.getState().localSettings).toBe(localSettings);
        expect(mmkv.getString('ui-state:onboarding-history-v1:homeWelcomeSeenAt')).toBeDefined();
        await act(async () => { first.at(-1)!.onLanded(); });
        await screen.update(<Home eligible seen={first} />);
        expect(first.at(-1)?.playing).toBe(false);
        await screen.unmount();

        const again: HomeWelcome[] = [];
        await renderScreen(<Home eligible seen={again} />);
        expect(again.some(welcome => welcome.playing)).toBe(false);
        writes.mockRestore();
    });

    it('counts a Loading cloud that already assembled the planet as the Welcome', async () => {
        const seen: HomeWelcome[] = [];
        const screen = await renderScreen(<Home eligible loadingShown seen={seen} />);
        await screen.update(<Home eligible loadingShown seen={seen} />);
        expect(seen.at(-1)?.playing).toBe(false);
        expect(onboardingHistoryState.read('homeWelcomeSeenAt')).toBeTypeOf('number');
    });

    it('shows the rest at once under reduced motion, with nothing re-typing', async () => {
        const seen: HomeWelcome[] = [];
        const screen = await renderScreen(<Home eligible reducedMotion seen={seen} />);
        await screen.update(<Home eligible reducedMotion seen={seen} />);
        expect(seen.at(-1)).toMatchObject({ playing: false, retype: false });
        expect(onboardingHistoryState.read('homeWelcomeSeenAt')).toBeTypeOf('number');
    });

    it('settles an in-progress assembly when reduced motion is selected', async () => {
        const seen: HomeWelcome[] = [];
        const screen = await renderScreen(<Home eligible seen={seen} />);
        expect(seen.at(-1)?.playing).toBe(true);
        await screen.update(<Home eligible reducedMotion seen={seen} />);
        expect(seen.at(-1)?.playing).toBe(false);
        expect(seen.some(welcome => !welcome.playing && welcome.arrive === 'instant')).toBe(true);
    });
});
