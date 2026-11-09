import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const account = createProviderSettingsAccountHarness();
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
const { loadLocalSettings } = await import('@/sync/domains/state/settingsPersistence');
const { createPersistentUiState } = await import('@/sync/domains/state/persistentUiState');

function findChoice(screen: Awaited<ReturnType<typeof renderSettingsView>>, testIDPrefix: string) {
    return screen.findAll((node) => node.props?.testIDPrefix === testIDPrefix)[0] ?? null;
}

// Load the real owner after boundaries during collection, outside behavior deadlines.
await import('./SessionComposerSettingsView');
const { Platform } = await import('react-native');
const { act } = await import('react-test-renderer');
describe('SessionComposerSettingsView', () => {
    beforeEach(async () => { await account.restore({ settings: { newSessionDraftEntryMode: 'resumePrevious', sessionInactiveResumePolicy: 'online_only', sessionMessageSendMode: 'agent_queue', sessionBusySteerSendPolicy: 'steer_immediately' } }); });
    afterEach(async () => { standardCleanup(); await account.reset(); });
    it('resets restored hidden banners without publishing a Settings write', async () => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ sessionComposerCollapsedBannerKinds: { usageLimitRecovery: true } }));
        storage.setState({ localSettings: loadLocalSettings() });
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));
        expect(screen.findAllHostsByTestId('settings-composer-resetHiddenBanners')).toHaveLength(1);
        const write = vi.spyOn(device, 'set');
        try {
            await screen.pressByTestIdAsync('settings-composer-resetHiddenBanners');
            expect(screen.findAllHostsByTestId('settings-composer-resetHiddenBanners')).toHaveLength(0);
            expect(write.mock.calls.filter(([key]) => key === 'local-settings' || key === 'settings' || key.startsWith('account-settings:'))).toHaveLength(0);
            expect(createPersistentUiState('composer-banner-collapse-v1', value => value).read('collapsed')).toEqual({});
        } finally { write.mockRestore(); }
    });
    it('shows explicit resume and fresh ordinary-entry choices and persists the selection', async () => {
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));
        const draftEntry = findChoice(screen, 'settings-new-session-draft-entry');

        expect(draftEntry?.props.value).toBe('resumePrevious');
        expect(draftEntry?.props.options.map((option: { id: string; label: string }) => [option.id, option.label])).toEqual([
            ['resumePrevious', 'Resume draft'],
            ['alwaysFresh', 'Start fresh'],
        ]);

        await screen.pressByTestIdAsync('settings-new-session-draft-entry:alwaysFresh');
        await vi.waitFor(() => expect(storage.getState().settings.newSessionDraftEntryMode).toBe('alwaysFresh'));
    });

    it('offers the inactive-session resume policies and persists changes', async () => {
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));
        const policy = findChoice(screen, 'settings-composer-inactive-resume');

        expect(policy?.props).toMatchObject({
            value: 'online_only',
            title: 'Automatic resume after sending',
        });
        expect(policy?.props.options.map((option: { id: string }) => option.id)).toEqual(['when_available', 'online_only', 'manual']);

        await screen.pressByTestIdAsync('settings-composer-inactive-resume:when_available');
        await vi.waitFor(() => expect(storage.getState().settings.sessionInactiveResumePolicy).toBe('when_available'));
    });

    it('keeps steering and pending-queue choices visible but locked, with the reason, while nothing can use them', async () => {
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsView));

        // The default send mode queues in the agent: steering applies, the pending queue does not.
        expect(findChoice(screen, 'settings-composer-busy-steer')?.props.disabled).toBe(false);
        expect(findChoice(screen, 'settings-composer-pending-drain')?.props.disabled).toBe(true);
        expect(findChoice(screen, 'settings-composer-pending-timing')?.props.disabled).toBe(true);
    });
});


it.each(['ios', 'android'] as const)('offers and saves Docked presentation on %s', async (platform) => {
    const previousOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    try {
        await account.restore({ settings: { newSessionPresentationModeV1: 'auto' } });
        const { SessionComposerSettingsView } = await import('./SessionComposerSettingsView');
        const screen = await renderSettingsView(<SessionComposerSettingsView />);
        expect(findChoice(screen, 'settings-new-session-presentation')?.props.options.map((option: { id: string }) => option.id)).toContain('docked');
        await screen.pressByTestIdAsync('settings-new-session-presentation:docked');
        await act(async () => {
            await vi.waitFor(() => expect(storage.getState().settings.newSessionPresentationModeV1).toBe('docked'));
        });
        expect(findChoice(screen, 'settings-new-session-presentation')?.props.value).toBe('docked');
    } finally {
        standardCleanup(); await account.reset();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previousOS });
    }
});

it.each(['ios', 'android'] as const)('persists the native New backdrop strength through its rendered control on %s', async platform => {
    const previous = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    try {
        await account.restore({ settings: { newSessionBackdropStrengthV1: 'soft' } });
        const { GlassAppearanceControls } = await import('../appearance/GlassAppearanceControls');
        const screen = await renderSettingsView(<GlassAppearanceControls presentation="tiles" />);
        await screen.pressByTestIdAsync('appearance-new-session-backdrop:rich');
        await act(async () => {
            await vi.waitFor(() => expect(storage.getState().settings.newSessionBackdropStrengthV1).toBe('rich'));
        });
    } finally {
        standardCleanup(); await account.reset();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
    }
});
