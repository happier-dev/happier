import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { useRecoveryKeyReminder } from '@/components/account/useRecoveryKeyReminder';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useDeviceType: () => 'phone',
}));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { FriendsView } = await import('./FriendsView');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const previous = storage.getState();
beforeEach(async () => { await homes.reset(); });

// People is a main screen (owner 11-10): the tab bar is its way around, so its title row draws no Back on a phone.
it('draws no Back on the People main screen on a phone', async () => {
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}><FriendsView /></InjectedAuthProvider>);
    expect(screen.findByTestId('people-page')).not.toBeNull();
    expect(screen.findHostByTestId('people:back')).toBeNull();
});

it('leaves the pending account recovery reminder on Home when visiting People', async () => {
    const serverId = await homes.addHome({ name: 'People', serverUrl: 'https://people-recovery.test', accountId: 'viewer' });
    await homes.selectHomes([serverId]);
    await TokenStorage.setRecoveryKeyReminderDismissed(false);
    const credentials = { token: 'test-token', secret: Buffer.alloc(32, 7).toString('base64') };
    const AccountShell = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    const reminder = await renderHook(() => useRecoveryKeyReminder({ surface: 'banner' }), { wrapper: AccountShell });
    await flushHookEffects({ cycles: 3 });
    expect(reminder.getCurrent().needed).toBe(true);
    const screen = await renderScreen(<AccountShell><FriendsView /></AccountShell>);
    expect(screen.findByTestId('recovery-key-reminder')).toBeNull();
});
afterEach(async () => { setScreenSharingPrivacyActive(false); standardCleanup(); storage.setState(previous, true); await homes.reset(); });

it('withdraws private shared Sessions from People and restores them after sharing', async () => {
    const serverId = await homes.addHome({ name: 'People', serverUrl: 'https://people-privacy.test', accountId: 'viewer' });
    await homes.selectHomes([serverId]);
    storage.setState({ isDataReady: true, profile: { ...previous.profile, id: 'viewer' }, sessions: {
        private: createSessionFixture({ id: 'private', serverId, owner: 'friend', metadata: { name: 'Secret launch', path: '/secret', host: 'tester.local' } }),
        public: createSessionFixture({ id: 'public', serverId, owner: 'friend', metadata: { name: 'Public plan', path: '/public', host: 'tester.local' } }),
    } });
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}><FriendsView /></InjectedAuthProvider>);
    expect(screen.getTextContent()).toContain('Secret launch');
    await act(async () => {
        storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
        storage.getState().setSessionTagAssignmentsOptimistic(serverId, 'private', ['private']);
        setScreenSharingPrivacyActive(true);
    });
    expect(screen.getTextContent()).not.toContain('Secret launch');
    expect(screen.getTextContent()).toContain('Public plan');
    await act(async () => setScreenSharingPrivacyActive(false));
    expect(screen.getTextContent()).toContain('Secret launch');
});
