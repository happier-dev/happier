import * as React from 'react';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserClipboardBoundary } from '@/dev/testkit/harness/browserClipboardBoundary';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

// The web copy path writes through the browser clipboard port, not expo-clipboard.
const setClipboardStringSafeMock = vi.hoisted(() => vi.fn(async (_value: string) => {}));
const modalAlertMock = vi.hoisted(() => vi.fn());
const homeTransportDiagnostics = [{
    homeServerIdentityId: 'home_1',
    state: 'connected' as const,
    current: { carrier: 'iroh' as const, observedPath: 'direct' as const },
    lastKnown: { carrier: 'iroh' as const, observedPath: 'direct' as const },
    lastTransitionAtMs: 1_788_200_000_000,
}];

afterEach(() => {
    standardCleanup();
    setClipboardStringSafeMock.mockReset();
    modalAlertMock.mockReset();
    retireIrohHomeTransportDiagnostics('home_1');
    storage.setState(initialStorageState, true);
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), setParams: vi.fn() } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ),
        translateLoose: (key: string) => key,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { alert: modalAlertMock },
    }).module;
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '1.2.3' }, deviceName: 'test-device' },
}));

vi.mock('expo-application', () => ({
    nativeApplicationVersion: '1.2.0', nativeBuildVersion: '101', applicationId: 'dev.happier.app',
}));

vi.mock('expo-updates', async () => ({
    ...(await import('@/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock(),
    channel: 'preview', updateId: 'update-123', runtimeVersion: '18',
    createdAt: new Date('2026-04-06T12:34:56.000Z'), isEmbeddedLaunch: false,
}));

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { createIrohHomeTransportDiagnosticsPublisher, retireIrohHomeTransportDiagnostics } = await import('@/sync/runtime/irohHomeTransportDiagnostics');
const { SystemStatusView } = await import('./SystemStatusView');
const initialStorageState = storage.getState();
beforeEach(async () => {
    network.resetRequests();
    const home = await network.addHome('http://example.local', 'prof_1', {
        credentials: { token: createAccountTokenForTests('prof_1', { currentAccount: true }) },
    });
    const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    await setActiveServerId(home.id);
    const state = storage.getState();
    state.applyProfile({ ...profileDefaults, id: 'prof_1', username: 'u1' });
    state.applyReady();
    state.setSocketStatus('connected');
    state.setSocketError('authorization=copy-me-never');
    state.setEndpointConnectivity({ status: 'online', reason: null, attempt: 1, nextRetryAt: null,
        lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null });
    state.applyMachines([], true, { sourceServerId: home.id });
    const publisher = createIrohHomeTransportDiagnosticsPublisher({
        producerId: 'system-status-runtime-test', leaseId: 'runtime-diagnostics', homeServerIdentityId: 'home_1',
    });
    publisher.publish(homeTransportDiagnostics[0]);
});
afterAll(async () => { await network.dispose(); });

describe('SystemStatusView app runtime info', () => {
    it('shows app runtime details and copies OTA runtime metadata into the system-status JSON payload', async () => {
        installBrowserClipboardBoundary(setClipboardStringSafeMock);
        const screen = await renderScreen(<SystemStatusView />);
        await flushHookEffects({ cycles: 10 });

        const text = screen.getTextContent();
        expect(text).toContain('bugReports.composer.environment.appVersionLabel');
        expect(text).toContain('1.2.3');
        expect(text).toContain('settingsAgents.releaseChannelTitle');
        expect(text).toContain('preview');
        expect(text).not.toContain('copy-me-never');
        expect(text).toContain('[redacted]');
        // Connection state reads as a word from the status vocabulary, never the raw enum.
        expect(text).toContain('status.connected');

        const copyRow = screen.find((node) => (
            node.props?.title === 'systemStatus.actions.copyJson' &&
            typeof node.props?.onPress === 'function'
        ));
        await pressTestInstanceAsync(copyRow, 'copy system status JSON');
        await act(async () => { await vi.waitFor(() => expect(setClipboardStringSafeMock).toHaveBeenCalledTimes(1)); });

        expect(setClipboardStringSafeMock).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).not.toHaveBeenCalled();

        const clipboardCalls = setClipboardStringSafeMock.mock.calls as unknown as Array<Array<string>>;
        const clipboardPayload = clipboardCalls[0]?.[0];
        const payload = JSON.parse(String(clipboardPayload ?? '{}'));
        expect(payload.environment).toMatchObject({
            appVersion: '1.2.3',
            nativeApplicationVersion: '1.2.0',
            nativeBuildVersion: '101',
            applicationId: 'dev.happier.app',
            updates: {
                channel: 'preview',
                updateId: 'update-123',
                runtimeVersion: '18',
                createdAt: '2026-04-06T12:34:56.000Z',
                launchSource: 'ota',
            },
        });
        expect(payload.homeTransports).toEqual(homeTransportDiagnostics);
        expect(payload.ui.socketLastError).not.toContain('copy-me-never');
        expect(payload.ui.socketLastError).toContain('[redacted]');
    });
});
