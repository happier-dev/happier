import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';

installApprovalCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ renderCustomModals: true }).module;
    },
});
const account = createProviderSettingsAccountHarness();
const { PluginInstallReviewSpecimen } = await import('./PluginInstallReviewSpecimen');
const { readSharedConsentFacts, readCombinedReviewCopy } = await import('@/components/settings/plugins/listing/PluginInstallOnMachines');
const { ModalProvider } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storage');

afterEach(async () => {
    standardCleanup();
    vi.unstubAllGlobals();
    await account.reset();
});

it.each((['plain', 'e2ee'] as const).flatMap(mode => (['review', 'settled', 'single'] as const).map(state => ({ mode, state }))))('renders $mode $state approvals after the live inventory drops local rows', async ({ mode, state }) => {
    await account.restore({ serverIdentityId: 'srv_specimen_home', machines: [],
        ...(mode === 'e2ee' ? { e2eeSecret: new Uint8Array(32).fill(17) } : {}) });
    // The dev HTTP overlay forwards unrelated requests to the real Home boundary.
    vi.stubGlobal('fetch', account.home.request);
    const screen = await renderScreen(<ModalProvider><PluginInstallReviewSpecimen state={state} /></ModalProvider>);
    if (state !== 'single') {
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.installOnMachines.target.build-box.switch')).not.toBeNull());
        const machineIds = state === 'review' ? ['build-box', 'lab-pi', 'guest-laptop'] : ['build-box', 'media-server', 'office-nas'];
        for (const machineId of machineIds) {
            await act(async () => {
                screen.findByTestId(`settings.plugins.installOnMachines.target.${machineId}.switch`)?.props.onValueChange(true);
            });
        }
        await screen.pressByTestIdAsync('settings.plugins.installOnMachines.continue');
    }
    await act(async () => { storage.getState().applyArtifacts([], storage.getState().artifacts); });
    await vi.waitFor(() => {
        const text = screen.getTextContent();
        expect(text).not.toContain('approvals.loadError');
        if (state === 'single') {
            expect(screen.findByTestId('approvals.in-place')).not.toBeNull();
        } else if (state === 'review') {
            expect(text).toContain('settingsPlugins.installDeclined');
            expect(text).toContain('actionConfirmations.homeUnavailable');
            expect(text).toContain('This Machine does not allow plugin installation.');
            expect(screen.findByTestId('settings.plugins.installOnMachines.install')?.props.disabled, text).toBe(false);
            // Studio Mac mini and build-box report the same release: its facts read once, above the Machines.
            expect(text.split('settingsPlugins.installReviewSections.identity').length - 1, text).toBe(1);
            expect(screen.findByTestId('settings.plugins.installOnMachines.shared')).not.toBeNull();
            // Its section says what is specific to it: Studio Mac mini waits on this confirm.
            expect(text).toContain('settingsPlugins.multiInstall.ready');
            // A confirm is pending: the reassurance stays.
            expect(text).toContain('settingsPlugins.multiInstall.footerNote');
        } else {
            expect(text).toContain('settingsPlugins.multiInstall.installed');
            expect(text).toContain('settingsPlugins.installDeclined');
            expect(text).toContain('settingsPlugins.multiInstall.superseded');
            expect(text).toContain('This Machine runs Happier 0.2.14');
            expect(text).not.toContain('actionConfirmations.homeUnavailable');
            expect(text.split('settingsPlugins.installReviewSections.identity').length - 1, text).toBe(1);
            // Nothing waits on a confirm any more, so "Nothing installs until you confirm" would be false.
            expect(text).not.toContain('settingsPlugins.multiInstall.footerNote');
        }
    });
});

it('reads a fact once only when every Machine that reported facts reported it identically', () => {
    const identity = (version: string) => ({ key: 'identity', title: 'Identity', value: `Storage Sync · ${version}` });
    const access = { key: 'access', title: 'Required host access', value: 'Storage account' };
    expect(readSharedConsentFacts([[identity('2.4.0'), access], [identity('2.4.0'), access]])).toEqual([identity('2.4.0'), access]);
    // A different version stays with each Machine; what still matches is read once.
    expect(readSharedConsentFacts([[identity('2.4.0'), access], [identity('2.3.9'), access]])).toEqual([access]);
    // A fact one Machine lacks is not common.
    expect(readSharedConsentFacts([[identity('2.4.0'), access], [identity('2.4.0')]])).toEqual([identity('2.4.0')]);
    // One Machine's facts are its own; Machines without facts (unavailable Home, refused) do not count.
    expect(readSharedConsentFacts([[identity('2.4.0'), access], []])).toEqual([]);
});

it('says "confirm once" in the header and footer only while a confirm is pending', () => {
    expect(readCombinedReviewCopy({ phase: 'choose', pending: false })).toEqual({
        subtitle: 'settingsPlugins.multiInstall.chooseDescription', note: 'settingsPlugins.multiInstall.footerNote' });
    expect(readCombinedReviewCopy({ phase: 'review', pending: true })).toEqual({
        subtitle: 'settingsPlugins.multiInstall.reviewDescription', note: 'settingsPlugins.multiInstall.footerNote' });
    // Settled: nothing waits on a confirm, so neither line may claim one.
    expect(readCombinedReviewCopy({ phase: 'review', pending: false })).toEqual({ subtitle: null, note: null });
});
