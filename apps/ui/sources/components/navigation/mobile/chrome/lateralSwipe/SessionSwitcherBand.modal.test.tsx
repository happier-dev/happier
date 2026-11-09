import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import type { CustomModalConfig } from '@/modal/types';
import { SessionSwitcherBand } from './SessionSwitcherBand';
import { SessionCockpitChromeRegistryProvider } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ModalProvider, useModal } from '@/modal/ModalProvider';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const phoneWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Dimensions: { get: () => phoneWindow },
        useWindowDimensions: () => phoneWindow,
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('phone session gestures under a modal', () => {
    it('disables the real band while a stage owns the phone and restores it after closing', async () => {
        const previousSettings = storage.getState().settings;
        storage.setState({ settings: { ...previousSettings,
            sessionCockpitSwipeNavigationEnabled: true,
            sessionSwitcherDragUpEnabled: true,
            sessionSwitcherFlickEnabled: true,
            sessionSwitcherHoldToDockEnabled: true,
        } });
        let modal!: ReturnType<typeof useModal>;
        function ModalControls() { modal = useModal(); return null; }
        function StageBody() { return null; }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<InjectedAuthProvider credentials={null}>
                <ModalProvider>
                    <ModalControls />
                    <SessionCockpitChromeRegistryProvider>
                        <SessionSwitcherBand sessionId="session" serverId="server"><React.Fragment /></SessionSwitcherBand>
                    </SessionCockpitChromeRegistryProvider>
                </ModalProvider>
            </InjectedAuthProvider>);
            const gestures = () => screen!.findByType('GestureDetector').props.gesture.gestures as { __config: { enabled: boolean } }[];
            expect(gestures().every(gesture => gesture.__config.enabled)).toBe(true);
            const stageModal = { type: 'custom', component: StageBody, chrome: { kind: 'stage' } } satisfies Omit<CustomModalConfig, 'id'>;
            await act(async () => { modal.showModal(stageModal); });
            expect(gestures().every(gesture => !gesture.__config.enabled)).toBe(true);
            await act(async () => { modal.hideAllModals(); });
            expect(gestures().every(gesture => gesture.__config.enabled)).toBe(true);
        } finally {
            await screen?.unmount();
            storage.setState({ settings: previousSettings });
        }
    });
});
