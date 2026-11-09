import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { HAPPIER_APP_STORE_URL, HAPPIER_DESKTOP_DOWNLOAD_URL, HAPPIER_GOOGLE_PLAY_URL } from '@/constants/downloadUrls';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { HomePairingPanel } = await import('./HomePairingPanel');
const { WebDesktopDownloadCta } = await import('@/components/onboarding/steps/webDesktop/WebDesktopDownloadCta');
const initialState = storage.getState();

beforeEach(async () => {
    await homes.reset();
    storage.setState(initialState, true);
});
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

it('admits explicit desktop and store listing presses before opening a platform URL', async () => {
    const { Linking } = await import('react-native');
    const nativeOpen = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { 'links.openExternal': { enabled: false } } }) } }));
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
        <HomePairingPanel purpose="computer" layout="section" testIDPrefix="computer" />
        <HomePairingPanel purpose="phone" layout="section" testIDPrefix="phone" />
        <WebDesktopDownloadCta testIDPrefix="onboarding" />
    </InjectedAuthProvider>);
    const controls = ['computer-desktop-download', 'phone-app-store', 'phone-google-play', 'onboarding-download-desktop'];
    try {
        for (const id of controls) await screen.pressByTestIdAsync(id);
        await flushHookEffects();
        expect(nativeOpen).not.toHaveBeenCalled();
        expect(opened).not.toHaveBeenCalled();

        storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } }));
        for (const id of controls) await screen.pressByTestIdAsync(id);
        await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(controls.length));
        expect(opened.mock.calls).toEqual([
            [HAPPIER_DESKTOP_DOWNLOAD_URL, '_blank', 'noopener,noreferrer'],
            [HAPPIER_APP_STORE_URL, '_blank', 'noopener,noreferrer'],
            [HAPPIER_GOOGLE_PLAY_URL, '_blank', 'noopener,noreferrer'],
            [HAPPIER_DESKTOP_DOWNLOAD_URL, '_blank', 'noopener,noreferrer'],
        ]);
        expect(nativeOpen).not.toHaveBeenCalled();
    } finally {
        await screen.unmount();
        nativeOpen.mockRestore();
    }
});
