// @vitest-environment jsdom
import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Keep real modal composition beneath the external DOM/Radix renderer adapters.
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
const navigatorBoundary = vi.hoisted(() => ({ rejectAmbient: false }));
const deviceState = vi.hoisted(() => ({ type: 'tablet' as 'phone' | 'tablet' }));
const routeState = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useDeviceType: () => deviceState.type,
}));
vi.mock('expo-router', async () => {
    const module = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: () => routeState.pathname }).module;
    return { ...module, useRouter: () => {
        if (navigatorBoundary.rejectAmbient) throw new Error('Browse body has no Expo navigator');
        return module.useRouter();
    } };
});
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { ExternalSessionsBrowseSurface } = await import('./ExternalSessionsBrowseModal');
const { ExternalSessionsBrowseScreen } = await import('./ExternalSessionsBrowseScreen');
const { CustomModal } = await import('@/modal/components/CustomModal');
const { storage } = await import('@/sync/domains/state/storageStore');
beforeEach(() => {
    navigatorBoundary.rejectAmbient = false;
    storage.setState({ machines: {}, machineListByServerId: {}, profileScope: null, settingsScope: null });
});
afterAll(() => network.dispose());

afterEach(async () => { await standardCleanup(); });

describe('Browse surface workspace host', () => {
    it('renders the real Browse content inside its destination rather than opening a modal', async () => {
        navigatorBoundary.rejectAmbient = true;
        const screen = await renderScreen(<DestinationInstanceHost tabId="browse"
            ref={{ kind: 'browseExistingSessions', params: {} }} pathname="/external/browse" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <ExternalSessionsBrowseSurface lockScope={null} onRequestClose={() => {}} />
        </DestinationInstanceHost>);
        expect(screen.findByTestId('direct-sessions-browse-modal')).not.toBeNull();
        expect(screen.root.findAllByType(CustomModal)).toHaveLength(0);
    });

    // A phone opens it from More, with no tab bar and no native header: its head is the only way out (QA-J3-1106).
    it('gives the phone destination its own Back, and the wide destination none', async () => {
        const render = () => renderScreen(<DestinationInstanceHost tabId="browse"
            ref={{ kind: 'browseExistingSessions', params: {} }} pathname="/external/browse" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <ExternalSessionsBrowseSurface lockScope={null} onRequestClose={() => {}} />
        </DestinationInstanceHost>);
        deviceState.type = 'phone';
        expect((await render()).findHostByTestId('external-sessions-browse:back')).not.toBeNull();
        deviceState.type = 'tablet';
        expect((await render()).findHostByTestId('external-sessions-browse:back')).toBeNull();
    });

    // A navigator screen (the native modal route, the new-session picker) has a header whose close or Back is the way out.
    it('draws no Back of its own on a phone navigator screen, whose header already closes it', async () => {
        deviceState.type = 'phone';
        routeState.pathname = '/external/browse';
        const screen = await renderScreen(<ExternalSessionsBrowseScreen onRequestClose={() => {}} />);
        deviceState.type = 'tablet';
        routeState.pathname = '/';
        expect(screen.findByTestId('direct-sessions-browse-modal')).not.toBeNull();
        expect(screen.findHostByTestId('external-sessions-browse:back')).toBeNull();
    });

    it('keeps the web modal presentation outside a workspace destination', async () => {
        const screen = await renderScreen(<ExternalSessionsBrowseSurface lockScope={null} onRequestClose={() => {}} />);
        expect(screen.root.findAllByType(CustomModal)).toHaveLength(1);
        expect(screen.findByTestId('direct-sessions-browse-modal')).not.toBeNull();
    });
});
