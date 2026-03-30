import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, renderScreen, standardCleanup } from '@/dev/testkit';

const activeServerSnapshot = {
    serverId: 'relay-1',
    serverUrl: 'https://relay.example.test/',
    generation: 1,
};
const setPendingSetupIntentMock = vi.fn();
const upsertServerProfileMock = vi.fn((params: { serverUrl: string; source?: string; replaceEquivalentStoredUrl?: boolean }) => ({
    id: `server:${params.serverUrl}`,
    serverUrl: params.serverUrl,
}));
const setActiveServerIdMock = vi.fn();
const tauriDesktopState = vi.hoisted(() => ({ value: true }));

const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
        replace: vi.fn(),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
    }),
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: setPendingSetupIntentMock,
    getPendingSetupIntent: () => null,
    clearPendingSetupIntent: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => ([
        {
            id: 'relay-1',
            name: 'Relay One',
            serverUrl: 'https://relay.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        },
    ]),
    setActiveServerId: setActiveServerIdMock,
    upsertServerProfile: upsertServerProfileMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/machines/MachineSetupFlowScreen', () => ({
    MachineSetupFlowScreen: (props: Record<string, unknown>) => React.createElement('MachineSetupFlowScreen', props),
}));

vi.mock('@/components/settings/server/localControl/LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: Record<string, unknown> & { onStatusChange?: (status: { relayUrl: string }) => void }) => {
        React.useEffect(() => {
            props.onStatusChange?.({ relayUrl: 'http://127.0.0.1:4555' });
        }, [props.onStatusChange]);

        return React.createElement('LocalRelayRuntimeControlSection', props);
    },
}));

vi.mock('@/components/settings/server/localControl/LocalTailscaleSecureAccessSection', () => ({
    LocalTailscaleSecureAccessSection: (props: Record<string, unknown>) => React.createElement('LocalTailscaleSecureAccessSection', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('/setup route pre-auth relay chooser', () => {
    beforeEach(() => {
        expoRouterMock.spies.push.mockReset();
        expoRouterMock.spies.replace.mockReset();
        setPendingSetupIntentMock.mockReset();
        tauriDesktopState.value = true;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('does not offer a local relay continue action before auth (setup stays relay-choice only)', async () => {
        tauriDesktopState.value = true;
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findByTestId('setup.continueWithLocalRelay')).toBeNull();
        expect(setPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(upsertServerProfileMock).not.toHaveBeenCalled();
        expect(setActiveServerIdMock).not.toHaveBeenCalled();
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalled();
        expect(screen.findAllByType('LocalTailscaleSecureAccessSection' as never)).toHaveLength(0);
    });
});
