import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

vi.mock('expo-router', async () => (
    await import('@/dev/testkit/mocks/router')
).createExpoRouterMock({ router: { replace }, pathname: '/session/recent' }).module);

vi.mock('@react-navigation/native', async () => (
    await import('@/dev/testkit/mocks/reactNavigation')
).createReactNavigationNativeMock());

vi.mock('react-native', async () => (
    await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock());

vi.mock('react-native-unistyles', async () => (
    await import('@/dev/testkit/mocks/unistyles')
).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (
    await import('@/dev/testkit/mocks/icons')
).createExpoVectorIconsMock());
vi.mock('@/text', async () => (
    await import('@/dev/testkit/mocks/text')
).createTextModuleMock());
vi.mock('@/modal', async () => (
    await import('@/dev/testkit/mocks/modal')
).createModalModuleMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
const { useSessionListLayoutChoice } = await import('@/hooks/session/sessionListLayoutIntent');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { default: LegacyRecentSessionsRoute } = await import('../../../../app/(app)/session/recent');

let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
const initialStorage = storage.getState();

describe('legacy Recent Sessions route', () => {
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.test/session/recent' });
        account = await createSecretSettingsTestHarness({ settings: settingsParse({
            // The Account's saved layout is Projects; the deep link must not change it.
            sessionListSectionModeV1: 'single', sessionListActiveGroupingV1: 'project',
        }), sharedEnabled: false });
        replace.mockClear();
        // App boot prepares browser draft storage before any route renders the New Session drafts.
        await prepareSessionDraftPersistenceStorage();
    });

    afterEach(async () => {
        try {
            await standardCleanup();
            await account?.dispose();
            await homes.reset();
            storage.setState(initialStorage, true);
        } finally {
            account = undefined;
            browser?.restore();
            browser = undefined;
        }
    });

    it('hosts the canonical list in Recent activity without writing the Account preference', async () => {
        if (!account) throw new Error('Recent route Account fixture is unavailable');
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
            <CommandPaletteProvider>
                <LegacyRecentSessionsRoute />
            </CommandPaletteProvider>
        </InjectedAuthProvider>);

        // The real list's View options resolve the visit intent through the
        // same layout reader as its rows, rather than substituting a list probe.
        const observedLayoutChoices = screen.findAllByType(DropdownMenu).flatMap(node => {
            // react-test-renderer erases this external component-query boundary.
            const items = node.props.items as readonly Readonly<{ id: string; checked?: boolean }>[];
            return items.filter(item => item.checked && item.id.startsWith('layout:'))
                .map(item => item.id.slice('layout:'.length));
        });

        expect(observedLayoutChoices).toEqual(['recent_activity']);
        expect(storage.getState().settings).toMatchObject({
            sessionListSectionModeV1: 'single', sessionListActiveGroupingV1: 'project',
        });
        expect(account.settingsWrites).toHaveLength(0);
        expect(replace).not.toHaveBeenCalled();
    });

    it('draws no second list where the Sessions column already stands beside the page', async () => {
        if (!account) throw new Error('Recent route Account fixture is unavailable');
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
            <CommandPaletteProvider>
                <AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
                    <LegacyRecentSessionsRoute />
                </AppShellColumnContext.Provider>
            </CommandPaletteProvider>
        </InjectedAuthProvider>);

        expect(screen.findByTestId('recent-sessions-screen')).toBeNull();
        expect(screen.findAll((node) => String(node.type) === 'Redirect').map((node) => node.props.href)).toEqual(['/']);
        expect(account.settingsWrites).toHaveLength(0);
    });

    it('leaves the stored layout authoritative outside the hosted route', async () => {
        let outsideChoice: string | null = null;
        function OutsideProbe() {
            outsideChoice = useSessionListLayoutChoice();
            return null;
        }

        await renderScreen(<OutsideProbe />);

        expect(outsideChoice).toBe('projects');
    });
});
