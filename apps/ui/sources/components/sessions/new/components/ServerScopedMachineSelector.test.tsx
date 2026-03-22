import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';


import type { ServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedItemProps: Array<Readonly<Record<string, unknown>>> = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                        View: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
                                    }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Readonly<Record<string, unknown>>) => {
        capturedItemProps.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement('Text', null, children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: (machine: { active?: boolean | null }) => Boolean(machine.active),
}));

describe('ServerScopedMachineSelector', () => {
    it('assigns stable item test IDs when a prefix is provided for grouped machine rows', async () => {
        const { ServerScopedMachineSelector } = await import('./ServerScopedMachineSelector');
        const machine = {
            id: 'machine-1',
            serverId: 'server-b',
            serverName: 'Server B',
            active: true,
            metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
        } as ServerScopedMachine;

        capturedItemProps.length = 0;

        await renderScreen(React.createElement(ServerScopedMachineSelector, {
                    groups: [
                        {
                            serverId: 'server-b',
                            serverName: 'Server B',
                            loading: false,
                            signedOut: false,
                            machines: [machine],
                        },
                        {
                            serverId: 'server-c',
                            serverName: 'Server C',
                            loading: false,
                            signedOut: false,
                            machines: [],
                        },
                    ],
                    selectedMachineId: 'machine-1',
                    selectedServerId: 'server-b',
                    onSelect: vi.fn(),
                    testIdPrefix: 'new-session-machine',
                }));

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'new-session-machine:machine-1',
            selected: true,
        }));
    });
});
