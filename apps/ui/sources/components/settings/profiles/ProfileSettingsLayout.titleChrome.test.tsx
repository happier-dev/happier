import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Install platform and navigation boundaries before any live Settings owner is
// evaluated; the collection and child-route resolver retain the real store.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/profiles/default-environment',
}).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const { getStorage } = await import('@/sync/domains/state/storage');
const { ProfileSettingsLayout } = await import('./ProfileSettingsLayout');
const { ProfileDefaultEnvironmentScreen } = await import('./ProfileDefaultEnvironmentScreen');
const { ProfileCollectionRail } = await import('./ProfileCollectionList');
const { ProfileSettingsIndex } = await import('./ProfileSettingsIndex');
const { CollectionList } = await import('@/components/ui/lists/collection/CollectionList');
const { Item } = await import('@/components/ui/lists/Item');
const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/PageHeader');
const { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { resetProfileCatalogEngineForTests } = await import('@/sync/engine/settings/profileCatalogEngine');
const { getActiveServerId } = await import('@/sync/domains/server/serverProfiles');

describe('Profiles phone title ownership', () => {
    const initialScope = getStorage().getState().settingsScope;
    beforeEach(() => {
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        const scope = { serverId: getActiveServerId(), accountId: 'profile-title-fixture' };
        getStorage().setState({ settingsScope: scope });
        applyProfileCatalogSnapshot(scope, { status: 'ready', source: 'destination', authority: 'active', records: [], control: null,
            controlRevision: 'absent', referenceGuardRevision: 'absent', diagnostics: [] }, true);
        getStorage().getState().applySettingsLocal({ useProfiles: false });
    });
    afterEach(() => {
        standardCleanup();
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        getStorage().setState({ settingsScope: initialScope });
    });

    it('counts the default environment among the choices rendered in the collection', async () => {
        const screen = await renderScreen(<ProfileCollectionRail />);
        const rows = screen.findAllByType(Item).filter((row) =>
            typeof row.props.testID === 'string' && row.props.testID.startsWith('settings.profiles.row.'));
        expect(rows.some((row) => row.props.testID === 'settings.profiles.row.defaultEnvironment')).toBe(true);
        expect(screen.findByType(CollectionList).props.count).toBe(rows.length);
    });

    it('says the saved profiles failed to load instead of counting only the built-in choices', async () => {
        resetProfileCatalogSnapshotsForTests();
        applyProfileCatalogSnapshot(getStorage().getState().settingsScope!, { status: 'unavailable', reason: 'unreachable' }, true);
        const screen = await renderScreen(<ProfileCollectionRail />);
        // Unknown is not zero: the count stays open and the rail names the failed read with its recovery.
        expect(screen.findByType(CollectionList).props.count).toBeUndefined();
        expect(screen.findByTestId('settings.profiles.rail.readFailed')).not.toBeNull();
        expect(screen.findByTestId('settings.profiles.rail.readFailed.retry')).not.toBeNull();
        expect(screen.findAllByProps({ testID: 'settings.profiles.row.defaultEnvironment' }).length).toBeGreaterThan(0);
    });

    it('shows the failed read as the phone list page instead of an empty Your profiles section', async () => {
        resetProfileCatalogSnapshotsForTests();
        applyProfileCatalogSnapshot(getStorage().getState().settingsScope!, { status: 'unavailable', reason: 'unreachable' }, true);
        getStorage().getState().applySettingsLocal({ useProfiles: true });
        const screen = await renderScreen(<ProfileSettingsIndex />);
        expect(screen.findByTestId('settings.profiles.collection.readFailed')).not.toBeNull();
        expect(screen.findByTestId('profiles-list-add-profile')).toBeNull();
    });

    it('titles the active child through the collection chrome even when profiles are disabled', async () => {
        const screen = await renderScreen(<ProfileSettingsLayout />);
        const activeHeader = screen.root.findAll((node) =>
            node.type === ('StackScreen' as never) && node.props.options !== undefined,
        )[0];
        expect(activeHeader?.props.options).toMatchObject({ headerTitle: 'profiles.noProfile' });
    });

    it('keeps the default-environment purpose and controls while navigation owns its title', async () => {
        const screen = await renderScreen(
            <NavigationTitleChromeProvider showsTitle>
                <ProfileDefaultEnvironmentScreen />
            </NavigationTitleChromeProvider>,
        );
        const headings = screen.root.findAll((node) =>
            typeof node.type === 'string' && node.props.accessibilityRole === 'header',
        ).map((node) => node.props.children);
        expect(headings.filter((heading) => heading === 'profiles.noProfile')).toHaveLength(0);
        expect(screen.findAllByProps({ children: 'profiles.noProfileDescription' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('settings.profiles.defaultEnvironment.favorite')).not.toBeNull();
    });
});
