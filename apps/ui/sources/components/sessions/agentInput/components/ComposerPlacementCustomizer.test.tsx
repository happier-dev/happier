// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { NavigationPlacementItem } from '@/components/ui/navigation/NavigationPlacementCustomizer';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/utils/web/reactDomCjs', () => ({
    // ReactTestRenderer cannot mount a DOM portal; the reorder owner remains real.
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));

installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
beforeAll(loadSyncSingletonForTests);
const { ComposerPlacementCustomizer } = await import('./ComposerPlacementCustomizer');

const items: readonly NavigationPlacementItem[] = [
    { id: 'attachments', title: 'Attachments', defaultPlacement: 'overflow' },
    { id: 'linkedFiles', title: 'Linked files', defaultPlacement: 'overflow' },
];

let serverId: string;
beforeEach(async () => {
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
    const { getStorage } = await import('@/sync/domains/state/storage');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    getStorage().setState({ settings: { ...settingsDefaults, experiments: false }, settingsScope: null });
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    serverId = await homes.addHome({ name: 'Upload Home', serverUrl: 'https://uploads.example', accountId: 'upload-account' });
});

afterEach(() => {
    standardCleanup();
});

async function publishUploads(enabled: unknown) {
    const payload = createRootLayoutFeaturesResponse();
    homes.answer(serverId, '/v1/features', {
        // Network boundary deliberately includes missing/malformed gate values.
        body: { ...payload, features: { ...payload.features, attachments: { uploads: enabled === undefined ? {} : { enabled } } } },
    });
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    await getServerFeaturesSnapshot({ serverId, force: true });
}

async function optIn(uploads: boolean) {
    const { getStorage } = await import('@/sync/domains/state/storage');
    getStorage().setState(state => ({
        settings: { ...state.settings, experiments: uploads, featureToggles: { 'attachments.uploads': uploads } },
    }));
}

async function mount() {
    const screen = await renderScreen(<ComposerPlacementCustomizer surfaceId="composer" items={items} onClose={() => {}} />);
    await act(async () => {});
    return screen;
}

const NOTE_ID = 'navigation-placement-customizer.note-action:attachments';
const text = (screen: Awaited<ReturnType<typeof mount>>) => JSON.stringify(screen.tree.toJSON());

describe('composer placement customizer: Attachments availability', () => {
    it('admits uploads without an experimental opt-in', async () => {
        await publishUploads(true);
        const screen = await mount();

        expect(text(screen)).not.toContain('navigationPlacement.attachments');
        expect(screen.findAllByTestId(NOTE_ID)).toHaveLength(0);
    });

    it('ignores a retired uploads opt-out', async () => {
        await publishUploads(true);
        await optIn(false);
        const screen = await mount();

        expect(text(screen)).not.toContain('navigationPlacement.attachments');
        expect(screen.findAllByTestId(NOTE_ID)).toHaveLength(0);
    });

    it.each([false, undefined, 'true', 1, null])('keeps a non-true server gate (%s) closed without nudging towards Settings', async (enabled) => {
        await publishUploads(enabled);
        const screen = await mount();

        expect(text(screen)).toContain('navigationPlacement.attachmentsUnavailable');
        expect(screen.findAllByTestId(NOTE_ID)).toHaveLength(0);
    });

    it('keeps the saved In + placement while the note is shown', async () => {
        await publishUploads(false);
        const screen = await mount();
        expect(screen.findAllByTestId('navigation-placement-customizer.placement:attachments:overflow').length).toBeGreaterThan(0);
    });
});
