import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRootLayoutFeaturesResponse, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { UpdatesPopoverButton } from '@/components/updates/UpdatesPopoverButton';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: key => key === 'workflows.openCollection' ? 'Open Workflows' : key,
    }));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        router: { push: routerPushSpy }, segments: [],
    }).module);

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

function publishFeatures(enabled: boolean) {
    const features = createRootLayoutFeaturesResponse({ features: {
        workflows: { enabled }, automations: { enabled },
    } });
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId,
        snapshot: { status: 'ready', features } });
}

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.findByProps({ accessibilityLabel: label });
}

describe('HomeHeader Workflows button', () => {
    const initialState = storage.getState();
    beforeEach(async () => {
        routerPushSpy.mockReset();
        await upsertAndActivateServer({ serverUrl: 'https://header-workflows.example.test', name: 'Header Home' });
        storage.setState({ settings: { ...initialState.settings, experiments: true,
            featureToggles: { ...initialState.settings.featureToggles, automations: true } } });
        publishFeatures(true);
    });
    afterEach(() => {
        standardCleanup();
        deleteServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId });
        storage.setState(initialState, true);
    });

    it('shows the Workflows button next to the logo and opens the one Workflows destination', async () => {
        const { HomeHeader } = await import('./HomeHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<HomeHeader />)).tree;

        const button = findPressableByLabel(tree!, 'Open Workflows');
        await act(async () => {
            await pressTestInstanceAsync(button);
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/workflows');
    });

    it('reaches a finger without growing the button, and never back into the logo it abuts', async () => {
        const { HomeHeader } = await import('./HomeHeader');
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}><HomeHeader /></HappierUiPlatformProvider>,
        );
        const area = await layoutHitArea(
            () => screen.tree.root.findAll((node) => node.props.accessibilityLabel === 'Open Workflows' && typeof node.props.onLayout === 'function')[0],
            { width: 32, height: 32 },
        );
        expect(area.drawn).toEqual({ width: 32, height: 32 });
        expect(area.insets.left).toBe(0);
        expect(area.height).toBe(44);
    });

    it('hides the Workflows button when the server denies the destination', async () => {
        publishFeatures(false);
        const { HomeHeader } = await import('./HomeHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<HomeHeader />)).tree;

        expect(() => findPressableByLabel(tree!, 'Open Workflows')).toThrow();
    });

    it('opens an explicit ordinary-entry draft route from the header action', async () => {
        const { HomeHeader } = await import('./HomeHeader');
        const tree = (await renderScreen(<HomeHeader />)).tree;

        tree.findByProps({ testID: 'home-header-start-new-session' }).props.onPress({
            nativeEvent: { ctrlKey: true },
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
    });

    it('keeps the logo in the mobile header slot while there is nothing to update', async () => {
        const { HomeHeader } = await import('./HomeHeader');

        const screen = await renderScreen(<HomeHeader />);

        // No provider in this render: the shared summary is empty, so the logo stays.
        expect(screen.tree.findAllByType(UpdatesPopoverButton)).toHaveLength(0);
    });
});
