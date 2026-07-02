import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

const isTauriDesktopState = vi.hoisted(() => ({ value: false }));
const connectionHealthState = vi.hoisted(() => ({
    value: {
        kind: 'connecting',
        machineCount: 0,
        onlineCount: 0,
        statusLabelKey: 'status.connecting',
        machineLabelKey: 'status.unknown',
    },
}));
const relayDriftBannerState = vi.hoisted(() => ({
    value: null as null | {
        kind: 'warning';
        title: string;
        description: string;
        actionLabel: string;
        onPress: () => void | Promise<void>;
        isRepairStarting: boolean;
        repairTaskSnapshot: null;
    },
}));
const applyTauriTrayState = vi.hoisted(() => vi.fn(async () => {}));
const useConnectionHealthSpy = vi.hoisted(() => vi.fn(() => connectionHealthState.value));
const useRelayDriftBannerSpy = vi.hoisted(() => vi.fn(() => relayDriftBannerState.value));

vi.mock('@/utils/platform/tauri', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/tauri')>('@/utils/platform/tauri');
    return {
        ...actual,
        isTauriDesktop: () => isTauriDesktopState.value,
    };
});

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => useConnectionHealthSpy(),
}));

vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => useRelayDriftBannerSpy(),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('./applyTauriTrayState', () => ({
    applyTauriTrayState,
}));

describe('DesktopTrayRuntime', () => {
    afterEach(() => {
        isTauriDesktopState.value = false;
        connectionHealthState.value = {
            kind: 'connecting',
            machineCount: 0,
            onlineCount: 0,
            statusLabelKey: 'status.connecting',
            machineLabelKey: 'status.unknown',
        };
        relayDriftBannerState.value = null;
        applyTauriTrayState.mockClear();
        useConnectionHealthSpy.mockClear();
        useRelayDriftBannerSpy.mockClear();
    });

    it('pushes the canonical connection health state into the desktop tray bridge when running in Tauri', async () => {
        isTauriDesktopState.value = true;
        connectionHealthState.value = {
            kind: 'healthy',
            machineCount: 2,
            onlineCount: 2,
            statusLabelKey: 'status.connected',
            machineLabelKey: 'status.online',
        };

        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        let tree = (await renderScreen(<DesktopTrayRuntime />)).tree;

        expect(applyTauriTrayState).toHaveBeenCalledWith({
            status: 'healthy',
            label: 'status.connected',
            detail: 'status.online · 2/2',
        });

        await act(async () => {
            tree.unmount();
        });
    });

    it('does not invoke the tray bridge outside the Tauri desktop shell', async () => {
        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        let tree = (await renderScreen(<DesktopTrayRuntime />)).tree;

        expect(applyTauriTrayState).not.toHaveBeenCalled();

        await act(async () => {
            tree.unmount();
        });
    });

    it('does not subscribe to tray state inputs outside the Tauri desktop shell', async () => {
        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        let tree = (await renderScreen(<DesktopTrayRuntime />)).tree;

        expect(useConnectionHealthSpy).not.toHaveBeenCalled();
        expect(useRelayDriftBannerSpy).not.toHaveBeenCalled();

        await act(async () => {
            tree.unmount();
        });
    });

    it('treats relay drift as attention required even when connection health is healthy', async () => {
        isTauriDesktopState.value = true;
        connectionHealthState.value = {
            kind: 'healthy',
            machineCount: 2,
            onlineCount: 2,
            statusLabelKey: 'status.connected',
            machineLabelKey: 'status.online',
        };
        relayDriftBannerState.value = {
            kind: 'warning',
            title: 'Relay drift detected',
            description: 'Switch to the daemon relay to continue.',
            actionLabel: 'server.repair',
            onPress: () => {},
            isRepairStarting: false,
            repairTaskSnapshot: null,
        };

        const { DesktopTrayRuntime } = await import('./DesktopTrayRuntime');
        let tree = (await renderScreen(<DesktopTrayRuntime />)).tree;

        expect(applyTauriTrayState).toHaveBeenCalledWith({
            status: 'attention_required',
            label: 'status.actionRequired',
            detail: 'Relay drift detected',
        });

        await act(async () => {
            tree.unmount();
        });
    });
});
